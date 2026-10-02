package updates

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"os"
)

func VerifyDigest(path string, expected []byte) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxArtifactSize {
		return errors.New("Invalid staged update file")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(file, MaxArtifactSize+1)); err != nil {
		return err
	}
	if len(expected) != sha256.Size || subtle.ConstantTimeCompare(hash.Sum(nil), expected) != 1 {
		return errors.New("The staged update was modified. Download it again.")
	}
	return nil
}
