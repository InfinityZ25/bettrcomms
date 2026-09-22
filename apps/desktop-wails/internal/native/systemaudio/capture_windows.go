//go:build windows

package systemaudio

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32    = windows.NewLazySystemDLL("ole32.dll")
	mmdevapi = windows.NewLazySystemDLL("mmdevapi.dll")

	procCoInitializeEx              = ole32.NewProc("CoInitializeEx")
	procCoUninitialize              = ole32.NewProc("CoUninitialize")
	procCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	procActivateAudioInterfaceAsync = mmdevapi.NewProc("ActivateAudioInterfaceAsync")
)

const (
	coinitMultithreaded = 0x0
	clsctxAll           = 0x17

	// Shared mode with loopback, converting whatever the endpoint runs at to
	// the fixed rate and layout the page expects.
	audclntShareModeShared           = 0
	audclntStreamflagsLoopback       = 0x00020000
	audclntStreamflagsAutoConvertPCM = 0x80000000
	audclntStreamflagsSRCDefaultQual = 0x08000000
	audclntBufferflagsSilent         = 0x2

	activationTypeProcessLoopback = 1
	// Include records only the target's tree; exclude records everything else,
	// which is how the call stays out of a system-audio share.
	loopbackModeIncludeTargetTree = 0
	loopbackModeExcludeTargetTree = 1

	vtBlob = 65

	// waveFormatIEEEFloat: the capture is delivered as 32-bit float.
	waveFormatIEEEFloat = 3

	// Vtable slots. Every interface here starts with IUnknown.
	slotRelease = 2

	// IAudioClient
	slotAudioClientInitialize = 3
	slotAudioClientStart      = 10
	slotAudioClientStop       = 11
	slotAudioClientGetService = 14

	// IAudioCaptureClient
	slotCaptureGetBuffer         = 3
	slotCaptureReleaseBuffer     = 4
	slotCaptureGetNextPacketSize = 5

	// IMMDeviceEnumerator / IMMDevice
	slotEnumeratorGetDefaultEndpoint = 4
	slotDeviceActivate               = 3

	// IActivateAudioInterfaceAsyncOperation
	slotGetActivateResult = 3

	eRender  = 0
	eConsole = 0

	// bufferDuration is 200 ms in 100-nanosecond units. Process loopback
	// requires a non-zero duration; the engine rounds it to its own period.
	bufferDuration = 2_000_000

	activationTimeout = 4 * time.Second
	// pollInterval is how often the capture thread checks for new packets. The
	// endpoint period is typically 10 ms, so this keeps up without spinning.
	pollInterval = 5 * time.Millisecond
)

// virtualAudioDeviceProcessLoopback is the pseudo-device process loopback is
// activated on.
var virtualAudioDeviceProcessLoopback = windows.StringToUTF16Ptr("VAD\\Process_Loopback")

var (
	clsidMMDeviceEnumerator = windows.GUID{Data1: 0xBCDE0395, Data2: 0xE52F, Data3: 0x467C,
		Data4: [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator = windows.GUID{Data1: 0xA95664D2, Data2: 0x9614, Data3: 0x4F35,
		Data4: [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient = windows.GUID{Data1: 0x1CB9AD4C, Data2: 0xDBFA, Data3: 0x4C32,
		Data4: [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioCaptureClient = windows.GUID{Data1: 0xC8ADBD64, Data2: 0xE71E, Data3: 0x48A0,
		Data4: [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
	iidIActivateAudioInterfaceCompletionHandler = windows.GUID{Data1: 0x41D949AB, Data2: 0x9862, Data3: 0x444A,
		Data4: [8]byte{0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}}
	iidIUnknown = windows.GUID{Data1: 0x00000000, Data2: 0x0000, Data3: 0x0000,
		Data4: [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	// IAgileObject is a marker interface with no methods of its own. It is not
	// optional here: ActivateAudioInterfaceAsync queries the completion handler
	// for it and fails the whole call with E_ILLEGAL_METHOD_CALL if the handler
	// is not agile, because it will invoke the handler on a thread of its own
	// choosing.
	iidIAgileObject = windows.GUID{Data1: 0x94EA2B94, Data2: 0xE9CC, Data3: 0x49E0,
		Data4: [8]byte{0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90}}
)

// waveFormatEx describes the format the capture is converted to.
type waveFormatEx struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	Size           uint16
}

// processLoopbackParams mirrors AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS inside
// AUDIOCLIENT_ACTIVATION_PARAMS, which is a tagged union with only this arm.
type activationParams struct {
	ActivationType  uint32
	TargetProcessID uint32
	LoopbackMode    uint32
}

// propVariant is the 24-byte PROPVARIANT that carries the activation blob.
type propVariant struct {
	VT        uint16
	Reserved1 uint16
	Reserved2 uint16
	Reserved3 uint16
	// blob is BLOB{ULONG cbSize; BYTE *pBlobData} with its alignment padding.
	BlobSize uint32
	_        uint32
	BlobData uintptr
}

// comObject is a COM interface pointer.
type comObject struct{ ptr unsafe.Pointer }

const vtableSlots = 32

func (o comObject) call(slot int, args ...uintptr) uintptr {
	vtable := *(**[vtableSlots]uintptr)(o.ptr)
	all := make([]uintptr, 0, len(args)+1)
	all = append(all, uintptr(o.ptr))
	all = append(all, args...)
	result, _, _ := syscall.SyscallN(vtable[slot], all...)
	return result
}

func (o comObject) release() {
	if o.ptr != nil {
		o.call(slotRelease)
	}
}

// --- The activation completion handler -----------------------------------
//
// ActivateAudioInterfaceAsync answers through a COM object the caller supplies,
// so one has to exist. Go has no COM object model, so the vtable is built by
// hand here: four function pointers, and a registry that maps the object's
// address back to the Go state, because a Go pointer must not be stored inside
// memory COM holds.

type handlerVtbl struct {
	QueryInterface    uintptr
	AddRef            uintptr
	Release           uintptr
	ActivateCompleted uintptr
}

type activationHandler struct {
	vtbl   *handlerVtbl
	refs   int32
	result chan comObject
	failed chan error
	once   sync.Once
}

var handlers struct {
	sync.Mutex
	byAddress map[uintptr]*activationHandler
}

func lookupHandler(this uintptr) *activationHandler {
	handlers.Lock()
	defer handlers.Unlock()
	return handlers.byAddress[this]
}

var handlerQueryInterface = syscall.NewCallback(func(this uintptr, iid *windows.GUID, out *uintptr) uintptr {
	if iid == nil || out == nil {
		return 0x80004003 // E_POINTER
	}
	// IAgileObject adds no methods, so the same pointer answers for it.
	if *iid == iidIUnknown || *iid == iidIActivateAudioInterfaceCompletionHandler || *iid == iidIAgileObject {
		*out = this
		return 0
	}
	*out = 0
	return 0x80004002 // E_NOINTERFACE
})

// The handler's lifetime is owned by the Go code that created it, which holds
// it until activation completes. Reference counting is therefore nominal.
var handlerAddRef = syscall.NewCallback(func(uintptr) uintptr { return 1 })
var handlerRelease = syscall.NewCallback(func(uintptr) uintptr { return 1 })

var handlerActivateCompleted = syscall.NewCallback(func(this uintptr, operation unsafe.Pointer) uintptr {
	handler := lookupHandler(this)
	if handler == nil {
		return 0
	}
	handler.once.Do(func() {
		if operation == nil {
			handler.failed <- errors.New("Audio activation returned no operation")
			return
		}
		var status uintptr
		var activated unsafe.Pointer
		asyncOperation := comObject{ptr: operation}
		hr := asyncOperation.call(slotGetActivateResult,
			uintptr(unsafe.Pointer(&status)), uintptr(unsafe.Pointer(&activated)))
		if hr != 0 {
			handler.failed <- fmt.Errorf("Audio activation failed: %w", windows.Errno(hr))
			return
		}
		if int32(status) < 0 {
			handler.failed <- fmt.Errorf("Audio activation was refused: %w", windows.Errno(status))
			return
		}
		if activated == nil {
			handler.failed <- errors.New("Audio activation returned no interface")
			return
		}
		handler.result <- comObject{ptr: activated}
	})
	return 0
})

var handlerVtable = handlerVtbl{
	QueryInterface:    handlerQueryInterface,
	AddRef:            handlerAddRef,
	Release:           handlerRelease,
	ActivateCompleted: handlerActivateCompleted,
}

func newActivationHandler() *activationHandler {
	handler := &activationHandler{
		vtbl:   &handlerVtable,
		result: make(chan comObject, 1),
		failed: make(chan error, 1),
	}
	handlers.Lock()
	if handlers.byAddress == nil {
		handlers.byAddress = map[uintptr]*activationHandler{}
	}
	handlers.byAddress[uintptr(unsafe.Pointer(handler))] = handler
	handlers.Unlock()
	return handler
}

func (h *activationHandler) dispose() {
	handlers.Lock()
	delete(handlers.byAddress, uintptr(unsafe.Pointer(h)))
	handlers.Unlock()
}

// --- Capture --------------------------------------------------------------

// capture records until stop is closed, appending to the ring.
//
// It runs on its own OS-locked thread: COM apartment state belongs to a thread,
// and a WASAPI client must be used from the thread that initialised COM.
func capture(stop <-chan struct{}, buffer *ring, ready chan<- error, selected target) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if hr, _, _ := procCoInitializeEx.Call(0, coinitMultithreaded); int32(hr) < 0 {
		return fmt.Errorf("Could not initialise audio COM: %w", windows.Errno(hr))
	}
	defer procCoUninitialize.Call()

	client, err := activateClient(selected)
	if err != nil {
		return err
	}
	defer client.release()

	format := waveFormatEx{
		FormatTag:      waveFormatIEEEFloat,
		Channels:       Channels,
		SamplesPerSec:  Rate,
		AvgBytesPerSec: Rate * frameBytes,
		BlockAlign:     frameBytes,
		BitsPerSample:  32,
	}
	// Initialize(shareMode, streamFlags, hnsBufferDuration, hnsPeriodicity,
	// pFormat, audioSessionGuid). The periodicity must be zero in shared mode;
	// the buffer duration is a hint the engine rounds to its own period.
	hr := client.call(slotAudioClientInitialize,
		audclntShareModeShared,
		audclntStreamflagsLoopback|audclntStreamflagsAutoConvertPCM|audclntStreamflagsSRCDefaultQual,
		bufferDuration,
		0,
		uintptr(unsafe.Pointer(&format)),
		0,
	)
	if int32(hr) < 0 {
		return fmt.Errorf("Could not initialise the system audio client: %w", windows.Errno(hr))
	}

	var capturePtr unsafe.Pointer
	hr = client.call(slotAudioClientGetService,
		uintptr(unsafe.Pointer(&iidIAudioCaptureClient)),
		uintptr(unsafe.Pointer(&capturePtr)))
	if int32(hr) < 0 || capturePtr == nil {
		return fmt.Errorf("Could not open the system audio capture service: %w", windows.Errno(hr))
	}
	captureClient := comObject{ptr: capturePtr}
	defer captureClient.release()

	if hr := client.call(slotAudioClientStart); int32(hr) < 0 {
		return fmt.Errorf("Could not start system audio capture: %w", windows.Errno(hr))
	}
	defer client.call(slotAudioClientStop)

	select {
	case ready <- nil:
	default:
	}

	silence := make([]byte, 0, readBytes)
	for {
		select {
		case <-stop:
			return nil
		default:
		}

		drained, err := drain(captureClient, buffer, &silence)
		if err != nil {
			return err
		}
		if !drained {
			// Nothing waiting; wait about half an endpoint period rather than
			// spinning the CPU on an idle stream.
			select {
			case <-stop:
				return nil
			case <-time.After(pollInterval):
			}
		}
	}
}

// drain moves every packet WASAPI has ready into the ring, reporting whether
// anything was taken.
func drain(captureClient comObject, buffer *ring, silence *[]byte) (bool, error) {
	var moved bool
	for {
		var frames uint32
		hr := captureClient.call(slotCaptureGetNextPacketSize, uintptr(unsafe.Pointer(&frames)))
		if int32(hr) < 0 {
			return moved, fmt.Errorf("Could not read the system audio packet size: %w", windows.Errno(hr))
		}
		if frames == 0 {
			return moved, nil
		}

		var data unsafe.Pointer
		var got, flags uint32
		hr = captureClient.call(slotCaptureGetBuffer,
			uintptr(unsafe.Pointer(&data)),
			uintptr(unsafe.Pointer(&got)),
			uintptr(unsafe.Pointer(&flags)),
			0, 0,
		)
		if int32(hr) < 0 {
			return moved, fmt.Errorf("Could not read system audio: %w", windows.Errno(hr))
		}

		size := int(got) * frameBytes
		if flags&audclntBufferflagsSilent != 0 || data == nil {
			// A silent packet carries no memory to read; the gap still has to
			// be represented or the stream would speed up.
			if cap(*silence) < size {
				*silence = make([]byte, size)
			}
			buffer.append((*silence)[:size])
		} else {
			buffer.append(unsafe.Slice((*byte)(data), size))
		}
		moved = true

		if hr := captureClient.call(slotCaptureReleaseBuffer, uintptr(got)); int32(hr) < 0 {
			return moved, fmt.Errorf("Could not release the system audio buffer: %w", windows.Errno(hr))
		}
	}
}

// activateClient opens the audio client for the selected target.
func activateClient(selected target) (comObject, error) {
	if selected.mode == ModeWholeSystem {
		return activateDefaultEndpoint()
	}

	handler := newActivationHandler()
	defer handler.dispose()

	mode := uint32(loopbackModeIncludeTargetTree)
	if selected.mode == ModeSystem {
		mode = loopbackModeExcludeTargetTree
	}
	params := activationParams{
		ActivationType:  activationTypeProcessLoopback,
		TargetProcessID: selected.processID,
		LoopbackMode:    mode,
	}
	// The blob points at stack-owned parameters. Nothing must ever call
	// PropVariantClear on this: it would try to free memory COM did not
	// allocate.
	variant := propVariant{
		VT:       vtBlob,
		BlobSize: uint32(unsafe.Sizeof(params)),
		BlobData: uintptr(unsafe.Pointer(&params)),
	}

	var operation unsafe.Pointer
	hr, _, _ := procActivateAudioInterfaceAsync.Call(
		uintptr(unsafe.Pointer(virtualAudioDeviceProcessLoopback)),
		uintptr(unsafe.Pointer(&iidIAudioClient)),
		uintptr(unsafe.Pointer(&variant)),
		uintptr(unsafe.Pointer(&handler.vtbl)),
		uintptr(unsafe.Pointer(&operation)),
	)
	if int32(hr) < 0 {
		return comObject{}, fmt.Errorf("Could not request process-loopback audio (0x%08x): %w", uint32(hr), windows.Errno(hr))
	}
	defer func() {
		if operation != nil {
			comObject{ptr: operation}.release()
		}
	}()
	// params must outlive the call: WASAPI reads the blob during activation.
	runtime.KeepAlive(&params)

	select {
	case client := <-handler.result:
		return client, nil
	case err := <-handler.failed:
		return comObject{}, err
	case <-time.After(activationTimeout):
		return comObject{}, errors.New("System audio activation timed out")
	}
}

// activateDefaultEndpoint opens ordinary loopback on the default output.
func activateDefaultEndpoint() (comObject, error) {
	var enumeratorPtr unsafe.Pointer
	hr, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)),
		0,
		clsctxAll,
		uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)),
		uintptr(unsafe.Pointer(&enumeratorPtr)),
	)
	if int32(hr) < 0 || enumeratorPtr == nil {
		return comObject{}, fmt.Errorf("Could not open the audio device list: %w", windows.Errno(hr))
	}
	enumerator := comObject{ptr: enumeratorPtr}
	defer enumerator.release()

	var devicePtr unsafe.Pointer
	hr2 := enumerator.call(slotEnumeratorGetDefaultEndpoint, eRender, eConsole, uintptr(unsafe.Pointer(&devicePtr)))
	if int32(hr2) < 0 || devicePtr == nil {
		return comObject{}, fmt.Errorf("Could not find the default output device: %w", windows.Errno(hr2))
	}
	device := comObject{ptr: devicePtr}
	defer device.release()

	var clientPtr unsafe.Pointer
	hr3 := device.call(slotDeviceActivate,
		uintptr(unsafe.Pointer(&iidIAudioClient)),
		clsctxAll,
		0,
		uintptr(unsafe.Pointer(&clientPtr)))
	if int32(hr3) < 0 || clientPtr == nil {
		return comObject{}, fmt.Errorf("Could not open the default output device: %w", windows.Errno(hr3))
	}
	return comObject{ptr: clientPtr}, nil
}

// ownProcessTree is the process excluded from a system-audio capture: this one,
// which WASAPI treats as the root of a tree covering the webview and every
// other child.
func ownProcessTree() (uint32, error) {
	return uint32(windows.GetCurrentProcessId()), nil
}

// windowsBuild reports the OS build number.
func windowsBuild() (uint32, bool) {
	major, minor, build := windows.RtlGetNtVersionNumbers()
	if major == 0 && minor == 0 && build == 0 {
		return 0, false
	}
	// The high bit is a checked-build marker, not part of the number.
	return build & 0x0FFFFFFF, true
}
