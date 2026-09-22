//go:build !windows

package deepfilter

const supported = false

// session has no implementation off Windows, where there is no DirectML.
type session struct{}

func openSession(install) (*session, string, error) { return nil, "", ErrUnsupportedPlatform }

func (*session) verifyContract(map[string]state) error { return ErrUnsupportedPlatform }

func (*session) run([]float32, map[string]state) ([]float32, error) {
	return nil, ErrUnsupportedPlatform
}

func (*session) close() {}
