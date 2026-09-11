//go:build windows

package deepfilter

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"

	"bettercomms/desktop-wails/internal/native/gpudevices"

	"golang.org/x/sys/windows"
)

const supported = true

// OrtApi slot indices.
//
// These are positions in the OrtApi function-pointer table, derived from
// onnxruntime_c_api.h. The table is append-only across releases, so every index
// below — all of them under 100 — is identical in every ONNX Runtime this
// package can meet. Adding one for a newer function would need the header for
// that version.
const (
	slotCreateStatus    = 0
	slotGetErrorCode    = 1
	slotGetErrorMessage = 2
	slotCreateEnv       = 3
	slotCreateSession   = 7
	slotRun             = 9

	slotCreateSessionOptions        = 10
	slotDisableMemPattern           = 17
	slotSetSessionGraphOptimization = 23
	slotSetIntraOpNumThreads        = 24
	slotSetSessionExecutionMode     = 13

	slotSessionGetInputCount  = 30
	slotSessionGetOutputCount = 31
	slotSessionGetInputName   = 36
	slotSessionGetOutputName  = 37

	slotCreateTensorWithData = 49
	slotGetTensorMutableData = 51

	slotGetDimensionsCount = 61
	slotGetDimensions      = 62
	slotGetTensorTypeShape = 65

	slotCreateCpuMemoryInfo = 69
	slotAllocatorFree       = 76
	slotGetDefaultAllocator = 78

	slotReleaseEnv                    = 92
	slotReleaseStatus                 = 93
	slotReleaseMemoryInfo             = 94
	slotReleaseSession                = 95
	slotReleaseValue                  = 96
	slotReleaseTensorTypeAndShapeInfo = 99
	slotReleaseSessionOptions         = 100
)

const (
	loggingLevelWarning = 2
	graphOptimizeAll    = 99
	executionSequential = 0
	tensorElementFloat  = 1
	deviceAllocator     = 0
	memTypeDefault      = 0

	// newestKnownAPIVersion is what this build's header describes. An older
	// runtime is negotiated down to, because the table is append-only and the
	// slots above exist in all of them.
	newestKnownAPIVersion  = 29
	oldestUsableAPIVersion = 11
)

var (
	kernel32               = windows.NewLazySystemDLL("kernel32.dll")
	procAddDllDirectory    = kernel32.NewProc("AddDllDirectory")
	procRemoveDllDirectory = kernel32.NewProc("RemoveDllDirectory")
	procLoadLibraryExW     = kernel32.NewProc("LoadLibraryExW")
	procFreeLibrary        = kernel32.NewProc("FreeLibrary")
	procGetProcAddress     = kernel32.NewProc("GetProcAddress")
)

const (
	loadLibrarySearchDLLLoadDir  = 0x00000100
	loadLibrarySearchDefaultDirs = 0x00001000
)

// runtimeSlots is how many entries of OrtApi this package indexes into. It only
// bounds the array type; nothing past the slots above is ever read.
const runtimeSlots = 128

// ortRuntime is the loaded onnxruntime.dll and its API table.
//
// Loading is process-wide and permanent: ONNX Runtime registers global state,
// and unloading it while a session exists would crash. One load is kept for the
// life of the process.
type ortRuntime struct {
	api    *[runtimeSlots]uintptr
	append uintptr // OrtSessionOptionsAppendExecutionProvider_DML
}

var (
	runtimeOnce   sync.Once
	loadedRuntime *ortRuntime
	runtimeErr    error
)

func (r *ortRuntime) call(slot int, args ...uintptr) uintptr {
	result, _, _ := syscall.SyscallN(r.api[slot], args...)
	return result
}

// callPointer invokes a foreign function that returns a pointer.
//
// A C function's return value arrives as an integer, and there is no way in Go
// to dereference foreign memory without converting one back to a pointer. This
// is the only place that happens, and it is sound here: every pointer it
// produces is into memory owned by onnxruntime.dll, which Go's collector
// neither owns nor moves, and which outlives every use below because the
// library is never unloaded.
func callPointer(fn uintptr, args ...uintptr) unsafe.Pointer {
	result, _, _ := syscall.SyscallN(fn, args...)
	return unsafe.Pointer(result)
}

// callPointerSlot is callPointer for an OrtApi entry.
func (r *ortRuntime) callPointerSlot(slot int, args ...uintptr) unsafe.Pointer {
	return callPointer(r.api[slot], args...)
}

// status turns an OrtStatus into an error and releases it.
//
// A null status is success. Anything else carries a message that has to be
// read before the status is freed.
func (r *ortRuntime) status(handle uintptr, what string) error {
	if handle == 0 {
		return nil
	}
	code := r.call(slotGetErrorCode, handle)
	message := r.callPointerSlot(slotGetErrorMessage, handle)
	detail := ""
	if message != nil {
		detail = windows.BytePtrToString((*byte)(message))
	}
	r.call(slotReleaseStatus, handle)
	if detail == "" {
		return fmt.Errorf("DeepFilterNet could not %s (ONNX Runtime code %d)", what, code)
	}
	return fmt.Errorf("DeepFilterNet could not %s: %s", what, detail)
}

// loadRuntime loads onnxruntime.dll from the verified install directory.
func loadRuntime(resolved install) (*ortRuntime, error) {
	runtimeOnce.Do(func() {
		loadedRuntime, runtimeErr = loadRuntimeOnce(resolved)
	})
	return loadedRuntime, runtimeErr
}

func loadRuntimeOnce(resolved install) (*ortRuntime, error) {
	// DirectML.dll and the shared provider sit beside onnxruntime.dll, and ORT
	// loads them by name. Adding that directory to the search path finds them
	// without putting the working directory on it.
	directory, err := windows.UTF16PtrFromString(filepath.Dir(resolved.runtimeDLL))
	if err != nil {
		return nil, errors.New("DeepFilterNet runtime directory is not representable")
	}
	cookie, _, _ := procAddDllDirectory.Call(uintptr(unsafe.Pointer(directory)))
	if cookie == 0 {
		return nil, errors.New("could not register the DeepFilterNet private runtime directory")
	}

	// DirectML is loaded first and kept loaded: ORT holds provider function
	// pointers into it for the life of a session.
	if _, err := loadLibrary(resolved.directMLDLL); err != nil {
		procRemoveDllDirectory.Call(cookie)
		return nil, err
	}
	library, err := loadLibrary(resolved.runtimeDLL)
	if err != nil {
		procRemoveDllDirectory.Call(cookie)
		return nil, err
	}

	base, err := symbol(library, "OrtGetApiBase")
	if err != nil {
		procFreeLibrary.Call(library)
		procRemoveDllDirectory.Call(cookie)
		return nil, err
	}
	appendDML, err := symbol(library, "OrtSessionOptionsAppendExecutionProvider_DML")
	if err != nil {
		procFreeLibrary.Call(library)
		procRemoveDllDirectory.Call(cookie)
		return nil, errors.New("this ONNX Runtime build has no DirectML provider")
	}

	basePtr := callPointer(base)
	if basePtr == nil {
		procFreeLibrary.Call(library)
		procRemoveDllDirectory.Call(cookie)
		return nil, errors.New("ONNX Runtime returned no API base")
	}
	// OrtApiBase is { GetApi, GetVersionString }.
	getAPI := *(*uintptr)(basePtr)

	// Negotiate down from what this build's header describes: an older runtime
	// returns null for a version it does not implement.
	var api unsafe.Pointer
	for version := newestKnownAPIVersion; version >= oldestUsableAPIVersion; version-- {
		if api = callPointer(getAPI, uintptr(version)); api != nil {
			break
		}
	}
	if api == nil {
		procFreeLibrary.Call(library)
		procRemoveDllDirectory.Call(cookie)
		return nil, errors.New("this ONNX Runtime is older than DeepFilterNet requires")
	}

	return &ortRuntime{
		api:    (*[runtimeSlots]uintptr)(api),
		append: appendDML,
	}, nil
}

func loadLibrary(path string) (uintptr, error) {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, fmt.Errorf("DeepFilterNet path %q is not representable", path)
	}
	handle, _, loadErr := procLoadLibraryExW.Call(
		uintptr(unsafe.Pointer(wide)), 0,
		loadLibrarySearchDLLLoadDir|loadLibrarySearchDefaultDirs)
	if handle == 0 {
		return 0, fmt.Errorf("could not load %s: %w", filepath.Base(path), loadErr)
	}
	return handle, nil
}

func symbol(library uintptr, name string) (uintptr, error) {
	raw := append([]byte(name), 0)
	address, _, _ := procGetProcAddress.Call(library, uintptr(unsafe.Pointer(&raw[0])))
	if address == 0 {
		return 0, fmt.Errorf("ONNX Runtime is missing %s", name)
	}
	return address, nil
}

// session is one loaded graph.
type session struct {
	runtime    *ortRuntime
	env        uintptr
	options    uintptr
	handle     uintptr
	memoryInfo uintptr

	// inputNames and outputNames are the C strings passed to Run, held for the
	// session's life so they are not reallocated per frame.
	inputNames  []*byte
	outputNames []*byte
	inputOrder  []string
	outputOrder []string
}

// openSession loads the model onto the selected GPU.
func openSession(resolved install) (*session, string, error) {
	runtime, err := loadRuntime(resolved)
	if err != nil {
		return nil, "", err
	}

	// DirectML is placed on an explicitly chosen adapter rather than whatever
	// device 0 happens to be, so the graph runs where the report says it does.
	adapter, err := gpudevices.PreferredAdapter()
	if err != nil {
		return nil, "", err
	}

	opened := &session{runtime: runtime}
	logID := append([]byte("bettercomms-deepfilter"), 0)
	if err := runtime.status(runtime.call(slotCreateEnv,
		loggingLevelWarning,
		uintptr(unsafe.Pointer(&logID[0])),
		uintptr(unsafe.Pointer(&opened.env))), "create the inference environment"); err != nil {
		return nil, "", err
	}

	if err := runtime.status(runtime.call(slotCreateSessionOptions,
		uintptr(unsafe.Pointer(&opened.options))), "create session options"); err != nil {
		opened.close()
		return nil, "", err
	}
	// DirectML requires sequential execution with memory pattern optimisation
	// off; with either left on, provider registration fails.
	if err := runtime.status(runtime.call(slotDisableMemPattern, opened.options),
		"configure the session"); err != nil {
		opened.close()
		return nil, "", err
	}
	if err := runtime.status(runtime.call(slotSetSessionExecutionMode, opened.options, executionSequential),
		"configure the session"); err != nil {
		opened.close()
		return nil, "", err
	}
	if err := runtime.status(runtime.call(slotSetSessionGraphOptimization, opened.options, graphOptimizeAll),
		"configure graph optimisation"); err != nil {
		opened.close()
		return nil, "", err
	}
	// One thread: the work is on the GPU, and extra CPU threads only add
	// scheduling jitter to a real-time filter.
	if err := runtime.status(runtime.call(slotSetIntraOpNumThreads, opened.options, 1),
		"configure threading"); err != nil {
		opened.close()
		return nil, "", err
	}

	// The DirectML provider is a plain exported function, not an OrtApi entry.
	appendStatus, _, _ := syscall.SyscallN(runtime.append, opened.options, uintptr(adapter.Index))
	if err := runtime.status(appendStatus, fmt.Sprintf("place the graph on %s", adapter.Name)); err != nil {
		opened.close()
		return nil, "", err
	}

	modelPath, err := windows.UTF16PtrFromString(resolved.model)
	if err != nil {
		opened.close()
		return nil, "", errors.New("DeepFilterNet model path is not representable")
	}
	if err := runtime.status(runtime.call(slotCreateSession,
		opened.env,
		uintptr(unsafe.Pointer(modelPath)),
		opened.options,
		uintptr(unsafe.Pointer(&opened.handle))),
		"load the model onto the GPU"); err != nil {
		opened.close()
		return nil, "", err
	}

	if err := runtime.status(runtime.call(slotCreateCpuMemoryInfo,
		deviceAllocator, memTypeDefault,
		uintptr(unsafe.Pointer(&opened.memoryInfo))), "describe host memory"); err != nil {
		opened.close()
		return nil, "", err
	}

	if err := opened.readNames(); err != nil {
		opened.close()
		return nil, "", err
	}
	return opened, adapter.Name, nil
}

// readNames reads the graph's input and output names once.
func (s *session) readNames() error {
	runtime := s.runtime
	var allocator uintptr
	if err := runtime.status(runtime.call(slotGetDefaultAllocator,
		uintptr(unsafe.Pointer(&allocator))), "obtain an allocator"); err != nil {
		return err
	}

	read := func(countSlot, nameSlot int, what string) ([]string, []*byte, error) {
		var count uintptr
		if err := runtime.status(runtime.call(countSlot, s.handle,
			uintptr(unsafe.Pointer(&count))), "read the model's "+what); err != nil {
			return nil, nil, err
		}
		names := make([]string, 0, count)
		pointers := make([]*byte, 0, count)
		for index := uintptr(0); index < count; index++ {
			var raw *byte
			if err := runtime.status(runtime.call(nameSlot, s.handle, index, allocator,
				uintptr(unsafe.Pointer(&raw))), "read the model's "+what); err != nil {
				return nil, nil, err
			}
			name := windows.BytePtrToString(raw)
			runtime.call(slotAllocatorFree, allocator, uintptr(unsafe.Pointer(raw)))

			names = append(names, name)
			// Kept as Go-owned C strings so Run can be handed stable pointers.
			owned := append([]byte(name), 0)
			pointers = append(pointers, &owned[0])
		}
		return names, pointers, nil
	}

	var err error
	if s.inputOrder, s.inputNames, err = read(slotSessionGetInputCount, slotSessionGetInputName, "inputs"); err != nil {
		return err
	}
	if s.outputOrder, s.outputNames, err = read(slotSessionGetOutputCount, slotSessionGetOutputName, "outputs"); err != nil {
		return err
	}
	return nil
}

// verifyContract checks the graph is the model this package knows how to
// drive.
//
// A model with different tensors would still load, and would then produce
// nonsense that only shows up as noise in someone's call.
func (s *session) verifyContract(states map[string]state) error {
	if len(s.inputOrder) != stateCount+1 || len(s.outputOrder) != stateCount+1 {
		return errors.New("DeepFilterNet model has an unexpected tensor contract.")
	}
	if s.inputOrder[0] != inputName {
		return errors.New("DeepFilterNet model has an unexpected tensor contract.")
	}
	for _, name := range s.inputOrder[1:] {
		if _, known := states[name]; !known {
			return errors.New("DeepFilterNet model has an unexpected tensor contract.")
		}
	}
	// Output i must be the new value of input i, or state would be carried
	// forward into the wrong tensor.
	for index, name := range s.inputOrder[1:] {
		if s.outputOrder[index+1] != "new_"+name {
			return errors.New("DeepFilterNet model state ordering does not match.")
		}
	}
	return nil
}

// run feeds one frame and the current state through the graph, updating the
// state in place.
func (s *session) run(frame []float32, states map[string]state) ([]float32, error) {
	runtime := s.runtime
	count := len(s.inputOrder)

	inputs := make([]uintptr, count)
	defer func() {
		for _, value := range inputs {
			if value != 0 {
				runtime.call(slotReleaseValue, value)
			}
		}
	}()

	frameShape := []int64{FrameSamples}
	if err := s.createTensor(frame, frameShape, &inputs[0]); err != nil {
		return nil, err
	}
	for index, name := range s.inputOrder[1:] {
		current := states[name]
		if err := s.createTensor(current.Values, current.Shape, &inputs[index+1]); err != nil {
			return nil, err
		}
	}

	outputs := make([]uintptr, count)
	defer func() {
		for _, value := range outputs {
			if value != 0 {
				runtime.call(slotReleaseValue, value)
			}
		}
	}()

	if err := runtime.status(runtime.call(slotRun,
		s.handle,
		0, // default run options
		uintptr(unsafe.Pointer(&s.inputNames[0])),
		uintptr(unsafe.Pointer(&inputs[0])),
		uintptr(count),
		uintptr(unsafe.Pointer(&s.outputNames[0])),
		uintptr(count),
		uintptr(unsafe.Pointer(&outputs[0])),
	), "process the frame"); err != nil {
		return nil, err
	}

	denoised, err := s.readTensor(outputs[0], FrameSamples)
	if err != nil {
		return nil, err
	}
	// The recurrent state moves forward only after every output has been read
	// successfully, so a failure part-way cannot leave it half-updated.
	updated := make([][]float32, count-1)
	for index, name := range s.inputOrder[1:] {
		current := states[name]
		values, err := s.readTensor(outputs[index+1], len(current.Values))
		if err != nil {
			return nil, err
		}
		updated[index] = values
	}
	for index, name := range s.inputOrder[1:] {
		copy(states[name].Values, updated[index])
	}
	return denoised, nil
}

func (s *session) createTensor(values []float32, shape []int64, out *uintptr) error {
	if len(values) == 0 || len(shape) == 0 {
		return errors.New("DeepFilterNet cannot build an empty tensor")
	}
	return s.runtime.status(s.runtime.call(slotCreateTensorWithData,
		s.memoryInfo,
		uintptr(unsafe.Pointer(&values[0])),
		uintptr(len(values)*4),
		uintptr(unsafe.Pointer(&shape[0])),
		uintptr(len(shape)),
		tensorElementFloat,
		uintptr(unsafe.Pointer(out)),
	), "build an input tensor")
}

// readTensor copies a float tensor out, checking it holds what was expected.
func (s *session) readTensor(value uintptr, expected int) ([]float32, error) {
	runtime := s.runtime

	var info uintptr
	if err := runtime.status(runtime.call(slotGetTensorTypeShape, value,
		uintptr(unsafe.Pointer(&info))), "describe an output tensor"); err != nil {
		return nil, err
	}
	defer runtime.call(slotReleaseTensorTypeAndShapeInfo, info)

	var dimensions uintptr
	if err := runtime.status(runtime.call(slotGetDimensionsCount, info,
		uintptr(unsafe.Pointer(&dimensions))), "describe an output tensor"); err != nil {
		return nil, err
	}
	shape := make([]int64, dimensions)
	if dimensions > 0 {
		if err := runtime.status(runtime.call(slotGetDimensions, info,
			uintptr(unsafe.Pointer(&shape[0])), dimensions), "describe an output tensor"); err != nil {
			return nil, err
		}
	}
	total := int64(1)
	for _, dimension := range shape {
		if dimension <= 0 {
			return nil, errors.New("DeepFilterNet returned a tensor with an unknown dimension")
		}
		total *= dimension
	}
	if total != int64(expected) {
		return nil, fmt.Errorf("DeepFilterNet returned %d values where %d were expected", total, expected)
	}

	var data *float32
	if err := runtime.status(runtime.call(slotGetTensorMutableData, value,
		uintptr(unsafe.Pointer(&data))), "read an output tensor"); err != nil {
		return nil, err
	}
	if data == nil {
		return nil, errors.New("DeepFilterNet returned an empty tensor")
	}
	// Copied out: the buffer belongs to the OrtValue, which is released when
	// this call returns.
	return append([]float32(nil), unsafe.Slice(data, expected)...), nil
}

func (s *session) close() {
	if s == nil || s.runtime == nil {
		return
	}
	// Released in the reverse of creation order: a session outliving its
	// environment is undefined.
	if s.memoryInfo != 0 {
		s.runtime.call(slotReleaseMemoryInfo, s.memoryInfo)
		s.memoryInfo = 0
	}
	if s.handle != 0 {
		s.runtime.call(slotReleaseSession, s.handle)
		s.handle = 0
	}
	if s.options != 0 {
		s.runtime.call(slotReleaseSessionOptions, s.options)
		s.options = 0
	}
	if s.env != 0 {
		s.runtime.call(slotReleaseEnv, s.env)
		s.env = 0
	}
}
