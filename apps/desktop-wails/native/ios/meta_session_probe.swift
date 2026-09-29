import Foundation
import MWDATCore

// Diagnostic-only: the Objective-C DeviceSession API does not expose the
// asynchronous error publisher. Observe it through Swift before starting.
@MainActor @objc(BCMetaSessionProbe)
public final class MetaSessionProbe: NSObject {
    private var session: DeviceSession?
    private var selector: SpecificDeviceSelector?
    private var listeners: [any AnyListenerToken] = []
    private var timeout: Task<Void, Never>?
    private var deviceSnapshot = "Device state unavailable"
    private var completion: ((String) -> Void)?

    @objc(startWithDevice:completion:)
    public func start(device: String, completion: @escaping (String) -> Void) {
        cancel()
        self.completion = completion
        do {
            let selector = SpecificDeviceSelector(device: device)
            self.selector = selector
            let session = try Wearables.shared.createSession(deviceSelector: selector)
            self.session = session
            if let device = session.device {
                deviceSnapshot = "link=\(device.linkState), worn=\(device.donState), hinges=\(device.hingeState), thermal=\(device.thermalLevel), battery=\(device.batteryLevel.map(String.init) ?? "unknown")"
                listeners.append(device.addDeviceStateListener { [weak self] state in
                    let snapshot = "link=\(state.linkState), worn=\(state.donState), hinges=\(state.hingeState), thermal=\(state.thermalLevel), battery=\(state.batteryLevel.map(String.init) ?? "unknown")"
                    Task { @MainActor in
                        guard self?.session === session else { return }
                        self?.deviceSnapshot = snapshot
                    }
                })
            }
            listeners.append(session.errorPublisher.listen { [weak self] error in
                let message = "Meta session error: \(String(describing: error)) — \(error.localizedDescription)"
                Task { @MainActor in
                    guard self?.session === session else { return }
                    self?.finish(message + " [" + (self?.deviceSnapshot ?? "unknown") + "]")
                }
            })
            listeners.append(session.statePublisher.listen { [weak self] state in
                Task { @MainActor in
                    guard self?.session === session else { return }
                    if state == .started {
                        self?.finish("The Swift SDK session reached ready; the Objective-C startup path needs investigation.")
                    } else if state == .stopped {
                        // Allow the error publisher to deliver its matching event.
                        try? await Task.sleep(for: .milliseconds(250))
                        guard self?.session === session else { return }
                        self?.finish("Meta stopped the session without publishing an underlying error.")
                    }
                }
            })
            timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, self?.session === session else { return }
                self?.finish("Meta session diagnostic timed out before readiness.")
            }
            try session.start()
        } catch {
            finish("Meta session start error: \(String(describing: error)) — \(error.localizedDescription)")
        }
    }

    private func finish(_ message: String) {
        let callback = completion
        cancel()
        callback?(message)
    }

    @objc public func cancel() {
        completion = nil
        timeout?.cancel()
        timeout = nil
        let tokens = listeners
        listeners.removeAll()
        session?.stop()
        session = nil
        selector = nil
        Task { for token in tokens { await token.cancel() } }
    }
}
