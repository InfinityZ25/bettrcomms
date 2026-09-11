//go:build windows

package gpudevices

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errNoAdapter = errors.New("No AMD or Intel graphics adapter is available for DirectML.")

var (
	dxgi                   = windows.NewLazySystemDLL("dxgi.dll")
	procCreateDXGIFactory1 = dxgi.NewProc("CreateDXGIFactory1")
)

// iidIDXGIFactory1 is {770aae78-f26f-4dba-a829-253c83d1b387}.
var iidIDXGIFactory1 = windows.GUID{
	Data1: 0x770aae78,
	Data2: 0xf26f,
	Data3: 0x4dba,
	Data4: [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87},
}

const (
	dxgiErrorNotFound       = 0x887A0002
	dxgiAdapterFlagSoftware = 2

	// Vtable slots. IDXGIFactory1 and IDXGIAdapter1 both begin with IUnknown
	// (QueryInterface, AddRef, Release) and IDXGIObject (four more).
	slotRelease       = 2
	slotEnumAdapters1 = 12
	slotGetDesc1      = 10
)

// dxgiAdapterDesc1 mirrors DXGI_ADAPTER_DESC1. The trailing fields are unused
// here but must be present so the struct has the layout DXGI writes into.
type dxgiAdapterDesc1 struct {
	Description           [128]uint16
	VendorID              uint32
	DeviceID              uint32
	SubSysID              uint32
	Revision              uint32
	DedicatedVideoMemory  uintptr
	DedicatedSystemMemory uintptr
	SharedSystemMemory    uintptr
	AdapterLUID           struct {
		LowPart  uint32
		HighPart int32
	}
	Flags uint32
}

// comObject is a COM interface pointer: a pointer to a pointer to a vtable.
//
// The referent is allocated by COM, not by Go, so it is never moved or
// collected and holding it as an unsafe.Pointer is safe. Keeping it typed —
// rather than as a bare uintptr — is what lets the vtable be indexed without
// reconstructing a pointer from an integer.
type comObject struct{ ptr unsafe.Pointer }

// vtableSlots is an upper bound for indexing, not a real interface size. No
// memory is read beyond the slot actually called.
const vtableSlots = 64

// call invokes vtable slot with this object as the first argument.
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

// CompatibleAdapters lists the AMD and Intel adapters DirectML can use, in DXGI
// ordinal order.
//
// DXGI owns every COM reference this creates, and each one is released before
// the function returns, including on the error paths.
func AllAdapters() ([]Adapter, error) {
	var factory comObject
	hr, _, _ := procCreateDXGIFactory1.Call(
		uintptr(unsafe.Pointer(&iidIDXGIFactory1)),
		uintptr(unsafe.Pointer(&factory)),
	)
	if hr != 0 {
		return nil, fmt.Errorf("CreateDXGIFactory1 failed: %w", windows.Errno(hr))
	}
	defer factory.release()

	var adapters []Adapter
	// The Rust host stops at 32; matching that keeps a driver enumeration bug
	// from spinning here rather than returning what it found.
	for index := uint32(0); index < 32; index++ {
		var adapter comObject
		hr := factory.call(slotEnumAdapters1, uintptr(index), uintptr(unsafe.Pointer(&adapter)))
		if hr == dxgiErrorNotFound {
			break
		}
		if hr != 0 {
			return nil, fmt.Errorf("EnumAdapters1(%d) failed: %w", index, windows.Errno(hr))
		}

		var desc dxgiAdapterDesc1
		hr = adapter.call(slotGetDesc1, uintptr(unsafe.Pointer(&desc)))
		adapter.release()
		if hr != 0 {
			return nil, fmt.Errorf("GetDesc1(%d) failed: %w", index, windows.Errno(hr))
		}

		if desc.Flags&dxgiAdapterFlagSoftware != 0 {
			continue
		}
		adapters = append(adapters, Adapter{
			Index:    int32(index),
			Name:     windows.UTF16ToString(desc.Description[:]),
			VendorID: desc.VendorID,
		})
	}
	return adapters, nil
}
