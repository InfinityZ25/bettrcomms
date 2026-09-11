//go:build windows

package nvidiaaudio

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const supported = true

var (
	kernel32               = windows.NewLazySystemDLL("kernel32.dll")
	procAddDllDirectory    = kernel32.NewProc("AddDllDirectory")
	procRemoveDllDirectory = kernel32.NewProc("RemoveDllDirectory")
	procLoadLibraryExW     = kernel32.NewProc("LoadLibraryExW")
	procFreeLibrary        = kernel32.NewProc("FreeLibrary")
	procGetProcAddress     = kernel32.NewProc("GetProcAddress")
)

const (
	// The SDK ships its own CUDA and TensorRT libraries beside it. Searching
	// the loaded DLL's own directory plus the standard ones finds those without
	// putting the current working directory on the search path.
	loadLibrarySearchDLLLoadDir  = 0x00000100
	loadLibrarySearchDefaultDirs = 0x00001000
)

// runtime is the loaded SDK.
type sdkRuntime struct {
	library   uintptr
	directory uintptr
	modelPath *byte

	create    uintptr
	destroy   uintptr
	setString uintptr
	setU32    uintptr
	setFloat  uintptr
	getU32    uintptr
	load      uintptr
	run       uintptr
}

// effect is one loaded denoiser.
type effect struct {
	handle       uintptr
	frameSamples uint32
	destroy      uintptr
	run          uintptr
}

// cstring returns a NUL-terminated copy for the SDK's C API.
func cstring(value string) *byte {
	raw := append([]byte(value), 0)
	return &raw[0]
}

// SDK parameter names, as C strings so they can be passed by pointer.
var (
	paramModelPath     = cstring("model_path")
	paramUseGPU        = cstring("use_default_gpu")
	paramEnableVAD     = cstring("enable_vad")
	paramIntensity     = cstring("intensity_ratio")
	paramSampleRate    = cstring("input_sample_rate")
	paramChannels      = cstring("num_input_channels")
	paramFrameSize     = cstring("num_input_samples_per_frame")
	effectNameDenoiser = cstring("denoiser")
)

func symbol(library uintptr, name string) (uintptr, error) {
	raw := append([]byte(name), 0)
	address, _, _ := procGetProcAddress.Call(library, uintptr(unsafe.Pointer(&raw[0])))
	if address == 0 {
		return 0, fmt.Errorf("NVIDIA Audio Effects SDK is missing %s", name)
	}
	return address, nil
}

// symbolAny takes the first name the SDK exports, because the destroy entry
// point was renamed between SDK versions.
func symbolAny(library uintptr, names ...string) (uintptr, error) {
	for _, name := range names {
		if address, err := symbol(library, name); err == nil {
			return address, nil
		}
	}
	return 0, fmt.Errorf("NVIDIA Audio Effects SDK is missing %v", names)
}

// loadRuntime loads the SDK from the app-private setup directory.
func loadRuntime() (*sdkRuntime, error) {
	dll, model, err := resolveSetup()
	if err != nil {
		return nil, err
	}

	directory, err := windows.UTF16PtrFromString(filepath.Dir(dll))
	if err != nil {
		return nil, errors.New("NVIDIA runtime directory is not representable")
	}
	cookie, _, _ := procAddDllDirectory.Call(uintptr(unsafe.Pointer(directory)))
	if cookie == 0 {
		return nil, errors.New("could not register the NVIDIA private runtime directory")
	}

	path, err := windows.UTF16PtrFromString(dll)
	if err != nil {
		procRemoveDllDirectory.Call(cookie)
		return nil, errors.New("NVIDIA SDK path is not representable")
	}
	library, _, loadErr := procLoadLibraryExW.Call(
		uintptr(unsafe.Pointer(path)),
		0,
		loadLibrarySearchDLLLoadDir|loadLibrarySearchDefaultDirs,
	)
	if library == 0 {
		procRemoveDllDirectory.Call(cookie)
		return nil, fmt.Errorf("could not load NVIDIA Audio Effects SDK: %w", loadErr)
	}

	loaded := &sdkRuntime{library: library, directory: cookie, modelPath: cstring(model)}
	for _, entry := range []struct {
		target *uintptr
		names  []string
	}{
		{&loaded.create, []string{"NvAFX_CreateEffect"}},
		{&loaded.destroy, []string{"NvAFX_DestroyEffect", "NvAFX_Destroy"}},
		{&loaded.setString, []string{"NvAFX_SetString"}},
		{&loaded.setU32, []string{"NvAFX_SetU32"}},
		{&loaded.setFloat, []string{"NvAFX_SetFloat"}},
		{&loaded.getU32, []string{"NvAFX_GetU32"}},
		{&loaded.load, []string{"NvAFX_Load"}},
		{&loaded.run, []string{"NvAFX_Run"}},
	} {
		address, err := symbolAny(library, entry.names...)
		if err != nil {
			loaded.close()
			return nil, err
		}
		*entry.target = address
	}
	return loaded, nil
}

func (r *sdkRuntime) close() {
	if r == nil {
		return
	}
	if r.library != 0 {
		procFreeLibrary.Call(r.library)
		r.library = 0
	}
	if r.directory != 0 {
		procRemoveDllDirectory.Call(r.directory)
		r.directory = 0
	}
}

// check turns an SDK status into an error naming what was being done.
func check(status uintptr, what string) error {
	if code := int32(status); code != 0 {
		return fmt.Errorf("NVIDIA Audio Effects could not %s (status %d)", what, code)
	}
	return nil
}

// createEffect loads the denoiser model onto the GPU.
func (r *sdkRuntime) createEffect(intensity float32, vad bool) (*effect, error) {
	var handle uintptr
	status, _, _ := syscall.SyscallN(r.create,
		uintptr(unsafe.Pointer(effectNameDenoiser)),
		uintptr(unsafe.Pointer(&handle)))
	if err := check(status, "create effect"); err != nil {
		return nil, err
	}
	if handle == 0 {
		return nil, errors.New("NVIDIA created a null effect handle")
	}

	created, err := r.configure(handle, intensity, vad)
	if err != nil {
		syscall.SyscallN(r.destroy, handle)
		return nil, err
	}
	return created, nil
}

func (r *sdkRuntime) configure(handle uintptr, intensity float32, vad bool) (*effect, error) {
	setString := func(name *byte, value *byte, what string) error {
		status, _, _ := syscall.SyscallN(r.setString, handle,
			uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(value)))
		return check(status, what)
	}
	setU32 := func(name *byte, value uint32, what string) error {
		status, _, _ := syscall.SyscallN(r.setU32, handle,
			uintptr(unsafe.Pointer(name)), uintptr(value))
		return check(status, what)
	}
	getU32 := func(name *byte, what string) (uint32, error) {
		var value uint32
		status, _, _ := syscall.SyscallN(r.getU32, handle,
			uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&value)))
		return value, check(status, what)
	}

	if err := setString(paramModelPath, r.modelPath, "set model"); err != nil {
		return nil, err
	}
	if err := setU32(paramUseGPU, 1, "select GPU"); err != nil {
		return nil, err
	}
	var vadValue uint32
	if vad {
		vadValue = 1
	}
	if err := setU32(paramEnableVAD, vadValue, "configure speech-only filtering"); err != nil {
		return nil, err
	}
	// The bit pattern, not the value. On Windows amd64 the Nth argument travels
	// in either the Nth integer register or the Nth XMM register depending on
	// its type, and Go's asmstdcall copies the first four integer registers
	// into XMM0-XMM3 for exactly this reason. Passing the bits in the third
	// slot therefore lands them in XMM2, where a float third argument belongs.
	status, _, _ := syscall.SyscallN(r.setFloat, handle,
		uintptr(unsafe.Pointer(paramIntensity)), uintptr(math.Float32bits(intensity)))
	if err := check(status, "set denoise intensity"); err != nil {
		return nil, err
	}

	if status, _, _ := syscall.SyscallN(r.load, handle); check(status, "load model") != nil {
		return nil, check(status, "load model")
	}

	sampleRate, err := getU32(paramSampleRate, "query sample rate")
	if err != nil {
		return nil, err
	}
	channels, err := getU32(paramChannels, "query channels")
	if err != nil {
		return nil, err
	}
	frameSamples, err := getU32(paramFrameSize, "query frame size")
	if err != nil {
		return nil, err
	}
	// The model has to match what the caller will feed it. A mismatch here
	// would show up as noise rather than as an error.
	if sampleRate != SampleRate || channels != 1 || frameSamples < 1 || frameSamples > MaxFrameSamples {
		return nil, fmt.Errorf("NVIDIA model has unsupported format: %d Hz, %d channels, %d samples",
			sampleRate, channels, frameSamples)
	}
	return &effect{handle: handle, frameSamples: frameSamples, destroy: r.destroy, run: r.run}, nil
}

func (e *effect) close() {
	if e == nil || e.handle == 0 {
		return
	}
	syscall.SyscallN(e.destroy, e.handle)
	e.handle = 0
}

// process denoises exactly one frame.
func (e *effect) process(samples []float32) ([]float32, error) {
	if uint32(len(samples)) != e.frameSamples {
		return nil, fmt.Errorf("NVIDIA audio requires exactly %d samples per frame", e.frameSamples)
	}

	output := make([]float32, len(samples))
	// The SDK takes arrays of channel pointers; this model is mono, so each is
	// a single-element array.
	inputs := [1]*float32{&samples[0]}
	outputs := [1]*float32{&output[0]}

	status, _, _ := syscall.SyscallN(e.run, e.handle,
		uintptr(unsafe.Pointer(&inputs[0])),
		uintptr(unsafe.Pointer(&outputs[0])),
		uintptr(e.frameSamples),
		1,
	)
	if err := check(status, "process frame"); err != nil {
		return nil, err
	}
	// A model that has gone wrong produces NaN or infinity, which downstream
	// would become a loud click rather than silence.
	for _, sample := range output {
		if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
			return nil, errors.New("NVIDIA Audio Effects produced a non-finite sample")
		}
	}
	return output, nil
}
