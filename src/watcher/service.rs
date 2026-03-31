use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, error, info};

use super::debouncer::{Debouncer, WatchEvent};
use super::processor::{EventProcessor, ProcessResult};

/// Background service that watches for filesystem events and processes them
/// through the indexing pipeline.
pub struct WatcherService {
    /// Receiver for raw filesystem events from the watcher backend.
    event_rx: mpsc::UnboundedReceiver<WatchEvent>,
    /// Debouncer that coalesces rapid-fire events into consolidated batches.
    debouncer: Debouncer,
    /// Counter for successfully processed events.
    events_processed: AtomicU64,
    /// Counter for processing errors.
    errors_count: AtomicU64,
    /// Graceful shutdown signal.
    shutdown: tokio::sync::watch::Receiver<bool>,
}

impl WatcherService {
    /// Create a new watcher service with the given event channel and debouncer.
    pub fn new(
        event_rx: mpsc::UnboundedReceiver<WatchEvent>,
        debouncer: Debouncer,
        shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Self {
        Self {
            event_rx,
            debouncer,
            events_processed: AtomicU64::new(0),
            errors_count: AtomicU64::new(0),
            shutdown,
        }
    }

    /// Run the main event loop. This consumes `self` and blocks until shutdown.
    pub async fn run(mut self) {
        let mut tick = interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let processor = EventProcessor::new();

        loop {
            tokio::select! {
                // Receive raw filesystem events and feed them into the debouncer.
                Some(event) = self.event_rx.recv() => {
                    self.debouncer.push(event);
                }

                // Periodic tick: drain any ready debounced events and process them.
                _ = tick.tick() => {
                    let ready = self.debouncer.drain_ready();
                    if !ready.is_empty() {
                        for event in ready {
                            self.process_debounced_event(&processor, event).await;
                        }
                    }
                }

                // Shutdown signal: drain remaining events and exit.
                _ = self.shutdown.changed() => {
                    info!("Watcher service shutting down");
                    let remaining = self.debouncer.drain_all();
                    for event in remaining {
                        self.process_debounced_event(&processor, event).await;
                    }
                    break;
                }
            }
        }
    }

    /// Process a single debounced event through the indexing pipeline.
    ///
    /// This helper encapsulates the processing, atomic counting, and error
    /// logging so that the main event loop stays flat.
    async fn process_debounced_event(&self, processor: &EventProcessor, event: WatchEvent) {
        match processor.process(event.clone()).await {
            Ok(result) => {
                self.events_processed.fetch_add(1, Ordering::Relaxed);
                self.log_process_result(result);
            }
            Err(e) => {
                self.errors_count.fetch_add(1, Ordering::Relaxed);
                error!("Failed to process {:?}: {}", event.path(), e);
            }
        }
    }

    /// Log the outcome of a successful processing step.
    fn log_process_result(&self, result: ProcessResult) {
        match result {
            ProcessResult::Indexed { path, symbols, chunks } => {
                info!("Indexed: {} ({} symbols, {} chunks)", path, symbols, chunks);
            }
            ProcessResult::Deleted { path } => {
                info!("Removed from index: {}", path);
            }
            ProcessResult::Skipped(reason) => {
                debug!("Skipped: {}", reason);
            }
        }
    }
}
