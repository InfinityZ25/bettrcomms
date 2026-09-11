//go:build !windows

package gpudevices

import "errors"

var errNoAdapter = errors.New("No AMD or Intel graphics adapter is available for DirectML.")

// CompatibleAdapters reports no adapters off Windows, where there is no DXGI
// and no DirectML. The empty result is not an error: callers ask this to decide
// whether a GPU path is available, and the answer here is simply no.
func AllAdapters() ([]Adapter, error) { return nil, nil }
