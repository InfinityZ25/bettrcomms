package gpudevices

import (
	"errors"
	"testing"
)

// PreferredAdapter ranks AMD ahead of Intel, and lower DXGI ordinals ahead of
// higher ones within a vendor. The ordinal is what DirectML indexes by, so the
// ordering must not be re-derived from list position.
func TestPreferredAdapterPrefersAMDThenLowestOrdinal(t *testing.T) {
	for _, test := range []struct {
		name  string
		input []Adapter
		want  int32
	}{
		{
			name: "AMD wins over a lower Intel ordinal",
			input: []Adapter{
				{Index: 0, Name: "Intel UHD", VendorID: VendorIntel},
				{Index: 3, Name: "Radeon", VendorID: VendorAMD},
			},
			want: 3,
		},
		{
			name: "lowest ordinal wins within a vendor",
			input: []Adapter{
				{Index: 2, Name: "Radeon B", VendorID: VendorAMD},
				{Index: 1, Name: "Radeon A", VendorID: VendorAMD},
			},
			want: 1,
		},
		{
			name: "Intel is used when it is all there is",
			input: []Adapter{
				{Index: 4, Name: "Intel Arc", VendorID: VendorIntel},
			},
			want: 4,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := pick(test.input)
			if err != nil {
				t.Fatalf("pick: %v", err)
			}
			if got.Index != test.want {
				t.Errorf("index = %d, want %d", got.Index, test.want)
			}
		})
	}
}

func TestPreferredAdapterReportsAnEmptyMachine(t *testing.T) {
	if _, err := pick(nil); !errors.Is(err, errNoAdapter) {
		t.Errorf("err = %v, want errNoAdapter", err)
	}
}

// Runs against whatever this machine actually has. An NVIDIA-only or headless
// machine legitimately has no DirectML adapter, so an empty list is a pass; a
// DXGI failure is not.
func TestEnumerationSucceedsOnThisMachine(t *testing.T) {
	adapters, err := CompatibleAdapters()
	if err != nil {
		t.Fatalf("CompatibleAdapters: %v", err)
	}
	for _, adapter := range adapters {
		if adapter.VendorID != VendorAMD && adapter.VendorID != VendorIntel {
			t.Errorf("adapter %d has vendor %#x, which should have been filtered", adapter.Index, adapter.VendorID)
		}
		if adapter.Name == "" {
			t.Errorf("adapter %d has no description", adapter.Index)
		}
		t.Logf("DirectML adapter %d: %s (vendor %#x)", adapter.Index, adapter.Name, adapter.VendorID)
	}
	if len(adapters) == 0 {
		t.Log("no AMD or Intel adapter on this machine; DirectML has no device here")
	}
}
