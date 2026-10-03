package main

import (
	"context"
	"encoding/json"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Platform methods are registered on the existing token-gated auth service.
func init() {
	application.RegisterBindingMethodID((*AuthService).AndroidCallAudio, 0xBC170101)
	application.RegisterBindingMethodID((*AuthService).AndroidScreenSender, 0xBC170102)
}
func (a *AuthService) AndroidCallAudio(token string, active bool) error {
	if err := a.authoriseNative(token); err != nil {
		return err
	}
	return androidCallAudio(active)
}
func (a *AuthService) AndroidScreenSender(ctx context.Context, token, command string, args json.RawMessage) (any, error) {
	if err := a.authoriseNative(token); err != nil {
		return nil, err
	}
	return androidScreenCommand(ctx, command, args)
}
