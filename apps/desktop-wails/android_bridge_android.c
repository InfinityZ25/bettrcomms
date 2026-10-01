//go:build android && cgo

#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "_cgo_export.h"

static JavaVM *vm;
static jobject host;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

JNIEXPORT void JNICALL Java_com_wails_app_BetterCommsNative_attach(JNIEnv *env, jclass cls, jobject controller, jstring home) {
    (*env)->GetJavaVM(env, &vm);
    pthread_mutex_lock(&lock);
    if (host) (*env)->DeleteGlobalRef(env, host);
    host = (*env)->NewGlobalRef(env, controller);
    pthread_mutex_unlock(&lock);
    const char *path = (*env)->GetStringUTFChars(env, home, NULL);
    if (path) { bc_android_home((char*)path); (*env)->ReleaseStringUTFChars(env, home, path); }
}

// Take a local reference under the lock; callbacks may race activity teardown.
char *bc_android_command(const char *command) {
    if (!vm) return NULL;
    JNIEnv *env = NULL;
    int attached = (*vm)->GetEnv(vm, (void**)&env, JNI_VERSION_1_6) == JNI_EDETACHED;
    if (attached && (*vm)->AttachCurrentThread(vm, &env, NULL) != JNI_OK) return NULL;
    if (!env) return NULL;
    pthread_mutex_lock(&lock);
    jobject local = host ? (*env)->NewLocalRef(env, host) : NULL;
    pthread_mutex_unlock(&lock);
    char *result = NULL;
    if (local) {
        jclass cls = (*env)->GetObjectClass(env, local);
        jmethodID method = (*env)->GetMethodID(env, cls, "command", "(Ljava/lang/String;)Ljava/lang/String;");
        jstring arg = (*env)->NewStringUTF(env, command);
        jstring response = method ? (*env)->CallObjectMethod(env, local, method, arg) : NULL;
        if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); result = strdup("Android native command failed"); }
        else if (response) {
            const char *value = (*env)->GetStringUTFChars(env, response, NULL);
            if (value) { result = strdup(value); (*env)->ReleaseStringUTFChars(env, response, value); }
        }
        if (response) (*env)->DeleteLocalRef(env, response);
        (*env)->DeleteLocalRef(env, arg);
        (*env)->DeleteLocalRef(env, cls);
        (*env)->DeleteLocalRef(env, local);
    }
    if (attached) (*vm)->DetachCurrentThread(vm);
    return result;
}
JNIEXPORT void JNICALL Java_com_wails_app_BetterCommsNative_encoded(JNIEnv *env, jclass cls, jint kind, jstring session, jbyteArray bytes, jlong pts) {
    jsize length = (*env)->GetArrayLength(env, bytes);
    if (length <= 0 || length > 16*1024*1024) return;
    jbyte *data = (*env)->GetByteArrayElements(env, bytes, NULL);
    const char *id = (*env)->GetStringUTFChars(env, session, NULL);
    if (data && id) bc_android_encoded(kind, (char*)id, data, length, pts);
    if (id) (*env)->ReleaseStringUTFChars(env, session, id);
    if (data) (*env)->ReleaseByteArrayElements(env, bytes, data, JNI_ABORT);
}
JNIEXPORT void JNICALL Java_com_wails_app_BetterCommsNative_screenStopped(JNIEnv *env, jclass cls, jstring session) {
    const char *id = (*env)->GetStringUTFChars(env, session, NULL);
    if (id) { bc_android_screen_stopped((char*)id); (*env)->ReleaseStringUTFChars(env, session, id); }
}
JNIEXPORT jlong JNICALL Java_com_wails_app_BetterCommsNative_encoderControl(JNIEnv *env, jclass cls, jint kind) {
    int force = 0;
    unsigned int bitrate = bc_android_encoder_control(kind, &force);
    return ((jlong)force << 32) | bitrate;
}
JNIEXPORT void JNICALL Java_com_wails_app_BetterCommsNative_stopped(JNIEnv *env, jclass cls, jint kind) { bc_android_stopped(kind); }
JNIEXPORT void JNICALL Java_com_wails_app_BetterCommsNative_detach(JNIEnv *env, jclass cls) {
    // Clear the JVM reference before shutting down senders: their publishing
    // callbacks must not post new work into an Activity being destroyed.
    pthread_mutex_lock(&lock);
    if (host) { (*env)->DeleteGlobalRef(env, host); host = NULL; }
    pthread_mutex_unlock(&lock);
    bc_android_shutdown();
}
