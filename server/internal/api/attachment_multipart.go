package api

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"io"
)

const AttachmentChunkBytes int64 = 8 << 20

type AttachmentPart struct {
	Number   int32
	ETag     string
	Checksum string
}
type MultipartAttachmentStorage interface {
	AttachmentStorage
	BeginMultipart(context.Context, string, string) (string, error)
	PutPart(context.Context, string, string, int32, io.Reader, int64, string) (string, error)
	CompleteMultipart(context.Context, string, string, []AttachmentPart) error
	AbortMultipart(context.Context, string, string) error
	Open(context.Context, string) (io.ReadCloser, int64, error)
	ObjectSize(context.Context, string) (int64, error)
}

func (s *S3AttachmentStorage) BeginMultipart(ctx context.Context, key, contentType string) (string, error) {
	result, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(key), ContentType: aws.String(contentType), ChecksumAlgorithm: types.ChecksumAlgorithmSha256})
	if err != nil {
		return "", err
	}
	return aws.ToString(result.UploadId), nil
}
func encodedChecksum(value string) string {
	data, _ := hex.DecodeString(value)
	return base64.StdEncoding.EncodeToString(data)
}
func (s *S3AttachmentStorage) PutPart(ctx context.Context, key, upload string, part int32, body io.Reader, size int64, checksum string) (string, error) {
	result, err := s.client.UploadPart(ctx, &s3.UploadPartInput{Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(upload), PartNumber: aws.Int32(part), Body: body, ContentLength: aws.Int64(size), ChecksumSHA256: aws.String(encodedChecksum(checksum))})
	if err != nil {
		return "", err
	}
	return aws.ToString(result.ETag), nil
}
func (s *S3AttachmentStorage) CompleteMultipart(ctx context.Context, key, upload string, parts []AttachmentPart) error {
	completed := make([]types.CompletedPart, 0, len(parts))
	for _, part := range parts {
		completed = append(completed, types.CompletedPart{PartNumber: aws.Int32(part.Number), ETag: aws.String(part.ETag), ChecksumSHA256: aws.String(encodedChecksum(part.Checksum))})
	}
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(upload), MultipartUpload: &types.CompletedMultipartUpload{Parts: completed}})
	return err
}
func (s *S3AttachmentStorage) AbortMultipart(ctx context.Context, key, upload string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(upload)})
	return err
}
func (s *S3AttachmentStorage) Open(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, 0, err
	}
	return result.Body, aws.ToInt64(result.ContentLength), nil
}
func (s *S3AttachmentStorage) ObjectSize(ctx context.Context, key string) (int64, error) {
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return 0, err
	}
	return aws.ToInt64(result.ContentLength), nil
}
