//go:build ios

package main

/*
void bc_meta_connect(void);
void bc_meta_start(void);
void bc_meta_stop(void);
*/
import "C"

func metaCameraConnect() error { C.bc_meta_connect(); return nil }
func metaCameraStart() error   { C.bc_meta_start(); return nil }
func metaCameraStop() error    { C.bc_meta_stop(); return nil }
