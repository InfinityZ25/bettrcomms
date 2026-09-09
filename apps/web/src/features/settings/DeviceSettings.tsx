import { useEffect, useRef, useState } from 'react';
import PushToTalkSettings from './PushToTalkSettings';
import CameraCard from './devices/CameraCard';
import MicrophoneCard from './devices/MicrophoneCard';
import OutputCard from './devices/OutputCard';
import { useCameraPreview } from './devices/useCameraPreview';
import { useDeviceInventory } from './devices/useDeviceInventory';
import { useMicrophoneTest } from './devices/useMicrophoneTest';
import { useOutputTest } from './devices/useOutputTest';
import './DeviceSettings.css';

/**
 * Choose and try out the microphone, speakers and camera.
 *
 * Each card owns one device and one live test. Those tests hold real audio and
 * video resources, so `alive` lets every pending continuation check whether this
 * screen is still mounted before touching them. Changing a device stops any test
 * that was demonstrating the previous one.
 */
export default function DeviceSettings() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [micStatus, setMicStatus] = useState('');
  const [cameraStatus, setCameraStatus] = useState('');

  const devices = useDeviceInventory({
    alive,
    onMicrophoneStatus: setMicStatus,
    onCameraStatus: setCameraStatus,
  });
  const microphoneTest = useMicrophoneTest({
    alive,
    input: devices.input,
    windowsDesktop: devices.windowsDesktop,
    refresh: devices.refresh,
    onStatus: setMicStatus,
  });
  const cameraPreview = useCameraPreview({
    alive,
    camera: devices.camera,
    refresh: devices.refresh,
    onStatus: setCameraStatus,
  });
  const outputTest = useOutputTest(alive);

  const stopMicrophone = () => {
    microphoneTest.stop();
    microphoneTest.stopPlayback();
  };

  return (
    <section className="device-settings" aria-label="Media devices">
      <PushToTalkSettings />
      <div className="device-settings__grid">
        <MicrophoneCard
          options={devices.microphones}
          value={devices.input}
          onChange={(value) => {
            stopMicrophone();
            devices.selectInput(value);
          }}
          status={micStatus}
          test={microphoneTest}
          windowsDesktop={devices.windowsDesktop}
          onEnable={() => {
            stopMicrophone();
            void devices.enable('microphone');
          }}
          onOpenPrivacy={() => void devices.openPrivacySettings('microphone')}
          onStatus={setMicStatus}
        />
        <OutputCard
          options={devices.speakers}
          value={devices.output}
          onChange={(value) => {
            microphoneTest.stopPlayback();
            outputTest.release();
            devices.selectOutput(value);
          }}
          status={outputTest.status}
          onTest={() => void outputTest.play()}
        />
        <CameraCard
          options={devices.cameras}
          value={devices.camera}
          onChange={(value) => {
            cameraPreview.forget();
            devices.selectCamera(value);
          }}
          status={cameraStatus}
          preview={cameraPreview}
          windowsDesktop={devices.windowsDesktop}
          onEnable={() => {
            cameraPreview.forget();
            void devices.enable('camera');
          }}
          onOpenPrivacy={() => void devices.openPrivacySettings('camera')}
        />
      </div>
    </section>
  );
}
