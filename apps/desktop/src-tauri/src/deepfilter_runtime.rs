//! DeepFilterNet3 streaming inference; DirectML registration and every graph node
//! must execute on the explicitly selected AMD/Intel GPU. No silent CPU backend.
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    time::Instant,
};

const FRAME: usize = 512;
// Three hops: analysis/synthesis overlap plus the model's lookahead.
const MODEL_DELAY: usize = 1536;
const STATES: &str = include_str!("../resources/deepfilter/initial_states.json");
#[derive(Clone, Deserialize)]
struct State {
    shape: Vec<i64>,
    values: Vec<f32>,
}
fn initial_states() -> Result<HashMap<String, State>, String> {
    let states: HashMap<String, State> = serde_json::from_str(STATES).map_err(|e| e.to_string())?;
    if states.len() != 12
        || states.values().any(|s| {
            s.shape.iter().any(|n| *n <= 0)
                || s.shape.iter().product::<i64>() as usize != s.values.len()
                || s.values.iter().any(|v| !v.is_finite())
        })
    {
        return Err("Bundled DeepFilterNet state contract is invalid.".into());
    }
    Ok(states)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use ort::{
        ep,
        session::{builder::GraphOptimizationLevel, Session, SessionInputValue},
        value::Tensor,
    };
    use std::sync::OnceLock;
    static DIRECTML_LIBRARY: OnceLock<libloading::os::windows::Library> = OnceLock::new();
    static RUNTIME_INIT: OnceLock<Result<(), String>> = OnceLock::new();

    pub struct DeepFilter {
        pub adapter_name: String,
        session: Session,
        states: HashMap<String, State>,
        names: Vec<String>,
        dry: VecDeque<f32>,
        dry_mix: f32,
    }
    impl DeepFilter {
        pub fn load(attenuation_db: f32) -> Result<Self, String> {
            if !attenuation_db.is_finite() || !(0.0..=100.0).contains(&attenuation_db) {
                return Err("Invalid DeepFilterNet maximum attenuation.".into());
            }
            let root = crate::deepfilter_setup::install_root()?;
            let runtime = root.join("runtime");
            // Missing optional resources remain retryable after installation.
            if !runtime.join("onnxruntime.dll").is_file()
                || !root.join("models/denoiser_model.onnx").is_file()
            {
                return Err("Set up DeepFilterNet to install its local GPU runtime.".into());
            }
            let adapter = crate::gpu_devices::preferred_adapter()?;
            RUNTIME_INIT
                .get_or_init(|| {
                    // Explicit app-private paths and safe dependency lookup. Keep the
                    // DirectML DLL alive as long as ORT can hold provider functions.
                    let dml = unsafe {
                        libloading::os::windows::Library::load_with_flags(
                            runtime.join("DirectML.dll"),
                            0x0000_0100 | 0x0000_1000,
                        )
                    }
                    .map_err(|e| e.to_string())?;
                    let _ = DIRECTML_LIBRARY.set(dml);
                    ort::init_from(runtime.join("onnxruntime.dll"))
                        .map_err(|e| e.to_string())?
                        .with_name("BetterComms DeepFilterNet")
                        .commit();
                    Ok(())
                })
                .clone()?;
            let session = Session::builder()
                .map_err(|e| e.to_string())?
                .with_intra_threads(1)
                .map_err(|e| e.to_string())?
                .with_inter_threads(1)
                .map_err(|e| e.to_string())?
                .with_parallel_execution(false)
                .map_err(|e| e.to_string())?
                .with_memory_pattern(false)
                .map_err(|e| e.to_string())?
                .with_optimization_level(GraphOptimizationLevel::All)
                .map_err(|e| e.to_string())?
                .with_config_entry("session.disable_cpu_ep_fallback", "1")
                .map_err(|e| e.to_string())?
                .with_execution_providers([ep::DirectML::default()
                    .with_device_id(adapter.index)
                    .build()
                    .error_on_failure()])
                .map_err(|e| e.to_string())?
                .commit_from_file(root.join("models/denoiser_model.onnx"))
                .map_err(|e| format!("DirectML could not load the complete GPU graph: {e}"))?;
            let names: Vec<_> = session
                .inputs()
                .iter()
                .map(|i| i.name().to_owned())
                .collect();
            let states = initial_states()?;
            if names.len() != 13
                || names[0] != "input_frame"
                || names[1..].iter().any(|name| !states.contains_key(name))
                || session.outputs().len() != 13
            {
                return Err("DeepFilterNet model has an unexpected tensor contract.".into());
            }
            for (output, name) in session.outputs().iter().skip(1).zip(names.iter().skip(1)) {
                if output.name() != format!("new_{name}") {
                    return Err("DeepFilterNet model state ordering does not match.".into());
                }
            }
            Ok(Self {
                adapter_name: adapter.name,
                session,
                states,
                names,
                dry: VecDeque::from(vec![0.0; MODEL_DELAY]),
                dry_mix: if attenuation_db >= 100.0 {
                    0.0
                } else {
                    10.0_f32.powf(-attenuation_db / 20.0)
                },
            })
        }
        pub fn reset(&mut self) -> Result<(), String> {
            self.states = initial_states()?;
            self.dry = VecDeque::from(vec![0.0; MODEL_DELAY]);
            Ok(())
        }
        pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>, String> {
            if input.len() != FRAME || input.iter().any(|v| !v.is_finite() || v.abs() > 8.0) {
                return Err("Invalid DeepFilterNet input frame.".into());
            }
            let frame = Tensor::from_array(([FRAME], input.to_vec())).map_err(|e| e.to_string())?;
            let mut feeds: Vec<(String, SessionInputValue)> =
                vec![("input_frame".into(), frame.into())];
            for name in &self.names[1..] {
                let state = &self.states[name];
                feeds.push((
                    name.clone(),
                    Tensor::from_array((state.shape.clone(), state.values.clone()))
                        .map_err(|e| e.to_string())?
                        .into(),
                ));
            }
            let outputs = self
                .session
                .run(feeds)
                .map_err(|e| format!("DirectML audio processing failed: {e}"))?;
            let (_, samples) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            if samples.len() != FRAME || samples.iter().any(|v| !v.is_finite() || v.abs() > 8.0) {
                return Err("DeepFilterNet returned invalid audio.".into());
            }
            let mut result = samples.to_vec();
            for (i, name) in self.names.iter().enumerate().skip(1) {
                let (shape, values) = outputs[i]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| e.to_string())?;
                let state = self
                    .states
                    .get_mut(name)
                    .ok_or("Missing DeepFilterNet state")?;
                if shape.as_ref() != state.shape.as_slice()
                    || values.len() != state.values.len()
                    || values.iter().any(|v| !v.is_finite())
                {
                    return Err("DeepFilterNet returned invalid model state.".into());
                }
                state.values.copy_from_slice(values);
            }
            for (sample, raw) in result.iter_mut().zip(input) {
                let delayed = self.dry.pop_front().unwrap_or(0.0);
                self.dry.push_back(*raw);
                *sample = delayed * self.dry_mix + *sample * (1.0 - self.dry_mix);
            }
            Ok(result)
        }
        pub fn validate_realtime(&mut self) -> Result<String, String> {
            // Finite non-silent input exercises the recurrent model, not just DLL loading.
            let frame: Vec<_> = (0..FRAME)
                .map(|i| (i as f32 * 0.071).sin() * 0.01)
                .collect();
            for _ in 0..8 {
                self.process(&frame)?;
            }
            let mut elapsed = Vec::with_capacity(48);
            for _ in 0..48 {
                let start = Instant::now();
                self.process(&frame)?;
                elapsed.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            let mean = elapsed.iter().sum::<f64>() / elapsed.len() as f64;
            elapsed.sort_by(f64::total_cmp);
            let p95 = elapsed[45];
            if mean > 8.0 || p95 > 10.667 {
                return Err(format!("{} could not process audio reliably in real time (mean {mean:.1} ms, p95 {p95:.1} ms per 10.7 ms frame). RNNoise remains available.", self.adapter_name));
            }
            Ok(format!(
                "{} · GPU processing validated at 48 kHz (p95 {p95:.1} ms per frame).",
                self.adapter_name
            ))
        }
    }
}
#[cfg(windows)]
pub use platform::DeepFilter;

#[cfg(not(windows))]
pub struct DeepFilter {
    pub adapter_name: String,
}
#[cfg(not(windows))]
impl DeepFilter {
    pub fn load(_: f32) -> Result<Self, String> {
        Err("DeepFilterNet DirectML requires Windows.".into())
    }
    pub fn reset(&mut self) -> Result<(), String> {
        Ok(())
    }
    pub fn process(&mut self, _: &[f32]) -> Result<Vec<f32>, String> {
        Err("DirectML is unavailable.".into())
    }
    pub fn validate_realtime(&mut self) -> Result<String, String> {
        Err("DirectML is unavailable.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_states_match_pinned_graph() {
        let states = initial_states().unwrap();
        assert_eq!(states["analysis_mem"].values.len(), FRAME);
        assert_eq!(states["rolling_c0_buf"].values.len(), 30720);
        assert_eq!(states["erb_norm_state"].values[0], -60.0);
        assert_eq!(states["erb_norm_state"].values[31], -90.0);
    }
    #[test]
    #[ignore = "requires installed DirectML runtime and an AMD/Intel GPU"]
    fn installed_gpu_processes_and_reset_repeats() {
        let mut effect = DeepFilter::load(100.0).unwrap();
        println!("{}", effect.validate_realtime().unwrap());
        effect.reset().unwrap();
        let input: Vec<_> = (0..FRAME).map(|i| (i as f32 * 0.02).sin() * 0.1).collect();
        let mut first = Vec::new();
        for _ in 0..100 {
            first.extend(effect.process(&input).unwrap());
        }
        effect.reset().unwrap();
        let mut second = Vec::new();
        for _ in 0..100 {
            second.extend(effect.process(&input).unwrap());
        }
        assert!(first.iter().any(|v| v.abs() > 1e-6));
        assert!(first.iter().zip(second).all(|(a, b)| (a - b).abs() < 1e-5));
    }
}
