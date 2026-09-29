package main

import (
	"bettercomms/desktop-wails/internal/desktop"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// The sign-in service is always bound. Register stable IDs for the iPhone
// methods so a c-archive's reflected package name cannot change the JS calls.
// Keep these values in sync with apps/web/src/desktop/iosNativeBindings.ts.
func init() {
	application.RegisterBindingMethodID((*AuthService).IOSCallAudioStart, 0xBC160101)
	application.RegisterBindingMethodID((*AuthService).IOSCallAudioStop, 0xBC160102)
	application.RegisterBindingMethodID((*AuthService).IOSScreenStart, 0xBC160103)
	application.RegisterBindingMethodID((*AuthService).IOSScreenStop, 0xBC160104)
	application.RegisterBindingMethodID((*AuthService).IOSMetaConnect, 0xBC160105)
	application.RegisterBindingMethodID((*AuthService).IOSMetaStart, 0xBC160106)
	application.RegisterBindingMethodID((*AuthService).IOSMetaStop, 0xBC160107)
}

func (a *AuthService) authoriseNative(hostToken string) error {
	if a == nil || a.gate == nil {
		return desktop.ErrUntrustedCaller
	}
	return a.gate.Authorise(hostToken)
}

func (a *AuthService) IOSCallAudioStart(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return iosCallAudioStart()
}

func (a *AuthService) IOSCallAudioStop(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return iosCallAudioStop()
}

func (a *AuthService) IOSScreenStart(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return iosAppScreenStart()
}

func (a *AuthService) IOSScreenStop(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return iosAppScreenStop()
}

func (a *AuthService) IOSMetaConnect(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return metaCameraConnect()
}

func (a *AuthService) IOSMetaStart(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return metaCameraStart()
}

func (a *AuthService) IOSMetaStop(hostToken string) error {
	if err := a.authoriseNative(hostToken); err != nil {
		return err
	}
	return metaCameraStop()
}
