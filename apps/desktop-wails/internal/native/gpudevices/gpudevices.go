// Package gpudevices enumerates the graphics adapters DirectML can run on.
//
// DXGI ordinals, rather than WMI list positions, select DirectML adapters. A
// WMI enumeration order is not the order DirectML indexes by, so an adapter
// chosen from one and passed to the other can silently be the wrong device.
package gpudevices

import "sort"

// Vendor IDs this host distinguishes. AMD and Intel are the adapters DirectML
// is used with; NVIDIA has its own path through NVIDIA Audio Effects, and is
// named here so that path can find its hardware.
const (
	VendorAMD    uint32 = 0x1002
	VendorIntel  uint32 = 0x8086
	VendorNVIDIA uint32 = 0x10de
)

// CompatibleAdapters lists the adapters DirectML is driven on here.
//
// AllAdapters reports every hardware adapter DXGI knows; this narrows that to
// the two vendors whose DirectML path this host actually uses, keeping an
// NVIDIA card from being handed to a graph that has a better route.
func CompatibleAdapters() ([]Adapter, error) {
	all, err := AllAdapters()
	if err != nil {
		return nil, err
	}
	compatible := make([]Adapter, 0, len(all))
	for _, adapter := range all {
		if adapter.VendorID == VendorAMD || adapter.VendorID == VendorIntel {
			compatible = append(compatible, adapter)
		}
	}
	return compatible, nil
}

// Adapter is one DirectML-capable graphics adapter, identified by the ordinal
// DirectML itself will use.
type Adapter struct {
	Index    int32  `json:"index"`
	Name     string `json:"name"`
	VendorID uint32 `json:"vendorId"`
}

// PreferredAdapter returns the adapter DirectML should use, preferring AMD and
// then the lowest DXGI ordinal.
func PreferredAdapter() (Adapter, error) {
	adapters, err := CompatibleAdapters()
	if err != nil {
		return Adapter{}, err
	}
	return pick(adapters)
}

// pick applies the ranking to an already-enumerated list, so the ordering can
// be tested without a graphics adapter present.
func pick(adapters []Adapter) (Adapter, error) {
	if len(adapters) == 0 {
		return Adapter{}, errNoAdapter
	}
	ranked := append([]Adapter(nil), adapters...)
	sort.SliceStable(ranked, func(i, j int) bool {
		left, right := ranked[i], ranked[j]
		if (left.VendorID == VendorAMD) != (right.VendorID == VendorAMD) {
			return left.VendorID == VendorAMD
		}
		return left.Index < right.Index
	})
	return ranked[0], nil
}
