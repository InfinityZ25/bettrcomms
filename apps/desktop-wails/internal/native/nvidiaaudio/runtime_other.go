//go:build !windows

package nvidiaaudio

const supported = false

// runtime and effect exist so the portable half compiles; neither is ever
// created off Windows, where the SDK does not exist.
type sdkRuntime struct{}

type effect struct{ frameSamples uint32 }

func loadRuntime() (*sdkRuntime, error) { return nil, ErrUnsupportedPlatform }

func (*sdkRuntime) close() {}

func (*sdkRuntime) createEffect(float32, bool) (*effect, error) { return nil, ErrUnsupportedPlatform }

func (*effect) close() {}

func (*effect) process([]float32) ([]float32, error) { return nil, ErrUnsupportedPlatform }
