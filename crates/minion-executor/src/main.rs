//! CLI entry point for minion-executor.
//!
//! Reads a work order YAML file, runs the executor loop, optionally applies
//! the resulting diffs to the filesystem, and outputs structured JSON to stdout.

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use tracing::info;

mod api_client;
mod config;
mod context;
mod diff;
mod executor;
mod gates;
mod mcp_client;
mod tools;
mod wo;

/// Minion executor: runs a single work order through a minimal tool-use loop.
#[derive(Parser, Debug)]
#[command(name = "minion-executor", version, about)]
struct Cli {
    /// Path to work order YAML file (required).
    #[arg(long = "wo")]
    work_order: PathBuf,

    /// Path to config YAML file.
    /// Defaults to ~/.agentboard/minion-executor.yaml.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Working directory for diff application.
    /// Defaults to the current directory.
    #[arg(long)]
    working_dir: Option<PathBuf>,

    /// Run the executor but don't apply diffs — just output the JSON result.
    #[arg(long)]
    dry_run: bool,

    /// Apply diffs to the filesystem after execution (default: false).
    #[arg(long)]
    apply_diffs: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Log to stderr so stdout is clean JSON.
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();

    let cli = Cli::parse();

    // Load configuration
    let cfg = load_config(cli.config.as_deref())?;

    // Load work order
    info!(path = %cli.work_order.display(), "Loading work order from file");
    let work_order = wo::WorkOrder::from_file(&cli.work_order)?;

    // Resolve working directory
    let working_dir = match cli.working_dir {
        Some(ref p) => p.clone(),
        None => std::env::current_dir()?,
    };

    // Run the executor
    let result = executor::execute(&cfg, &work_order, &working_dir).await?;

    // Optionally apply diffs to the filesystem
    if cli.apply_diffs && !cli.dry_run && result.success {
        info!(count = result.diffs.len(), "Applying diffs to filesystem");
        diff::apply_diffs(&result.diffs, &working_dir)?;
    } else if cli.dry_run {
        info!("Dry-run mode: skipping diff application");
    }

    // Print ExecutionResult as JSON to stdout
    let output = serde_json::to_string_pretty(&result)?;
    println!("{output}");

    if result.success {
        Ok(())
    } else {
        std::process::exit(1);
    }
}

/// Load config from a YAML file, falling back to defaults.
fn load_config(path: Option<&std::path::Path>) -> Result<config::Config> {
    // Determine config path: explicit arg > ~/.agentboard/minion-executor.yaml > defaults
    let config_path = path
        .map(|p| p.to_path_buf())
        .or_else(|| {
            dirs_next::home_dir()
                .map(|h| h.join(".agentboard").join("minion-executor.yaml"))
        });

    if let Some(ref p) = config_path {
        if p.exists() {
            info!(path = %p.display(), "Loading config from file");
            let contents = std::fs::read_to_string(p)?;
            let cfg: config::Config = serde_yaml::from_str(&contents)?;
            return Ok(cfg);
        }
    }

    info!("No config file found; using defaults");
    Ok(config::Config::default())
}
