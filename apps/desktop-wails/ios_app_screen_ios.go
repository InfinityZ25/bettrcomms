//go:build ios

package main

/*
void bc_ios_screen_start(void);
void bc_ios_screen_stop(void);
*/
import "C"

func iosAppScreenStart() error { C.bc_ios_screen_start(); return nil }
func iosAppScreenStop() error  { C.bc_ios_screen_stop(); return nil }
