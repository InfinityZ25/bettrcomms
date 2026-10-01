#!/usr/bin/env python3
"""Verify the Android wrapper before executing its Java code."""
import hashlib
from pathlib import Path

# https://services.gradle.org/distributions/gradle-8.13-wrapper.jar.sha256
EXPECTED = '81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f'
wrapper = Path(__file__).resolve().parent.parent / 'apps/desktop-wails/android/gradle/wrapper/gradle-wrapper.jar'
if hashlib.sha256(wrapper.read_bytes()).hexdigest() != EXPECTED:
    raise SystemExit('Android Gradle wrapper checksum does not match the official 8.13 release')
print('Verified official Gradle 8.13 wrapper')
