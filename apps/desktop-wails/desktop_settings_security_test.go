package main

import (
	"bettercomms/desktop-wails/internal/desktop"
	"context"
	"errors"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDesktopSettingsRejectUntrustedPagesBeforeOSOrNetworkWork(t *testing.T) {
	gate, err := desktop.NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	for _, service := range []any{&DesktopPreferencesService{gate: gate}, &DesktopUpdateService{gate: gate}} {
		for i := 0; i < reflect.TypeOf(service).NumMethod(); i++ {
			name := reflect.TypeOf(service).Method(i).Name
			if name == "ServiceShutdown" {
				continue
			}
			t.Run(name, func(t *testing.T) {
				method := reflect.ValueOf(service).MethodByName(name)
				args := make([]reflect.Value, method.Type().NumIn())
				for j := range args {
					typ := method.Type().In(j)
					if typ == reflect.TypeFor[context.Context]() {
						args[j] = reflect.ValueOf(context.Background())
					} else {
						args[j] = reflect.Zero(typ)
					}
				}
				results := method.Call(args)
				failure, ok := results[len(results)-1].Interface().(error)
				if !ok || !errors.Is(failure, desktop.ErrUntrustedCaller) {
					t.Fatalf("unauthorised call %v", failure)
				}
			})
		}
	}
}
func TestUpdateRestartDoesNotInterruptNativeOrPageActivity(t *testing.T) {
	gate, err := desktop.NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	service := newDesktopUpdateService(gate, false, func() bool { return true })
	service.updater = updater.New(nil)
	service.status.State = "ready"
	service.expires = time.Now().Add(time.Hour)
	if err := service.Restart(context.Background(), gate.Token()); err == nil || !strings.Contains(err.Error(), "Leave the call") {
		t.Fatalf("restart during native work: %v", err)
	}
	service.busy = func() bool { return false }
	id := "d27d7274-e2b6-4b18-bf3d-31d24c45b25a"
	if err := service.Activity(gate.Token(), id, true); err != nil {
		t.Fatal(err)
	}
	if err := service.Restart(context.Background(), gate.Token()); err == nil || !strings.Contains(err.Error(), "Leave the call") {
		t.Fatalf("restart during page capture: %v", err)
	}
	if err := service.Activity(gate.Token(), id, false); err != nil {
		t.Fatal(err)
	}
	if len(service.activities) != 0 {
		t.Fatal("activity lease not released")
	}
}
