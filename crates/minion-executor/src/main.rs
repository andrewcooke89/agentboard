//! CLI entry point for minion-executor.
//!
//! Supports two subcommands:
//! - `run`: Execute a single work order (original behavior).
//! - `dispatch`: Dispatch a group of work orders with dependency resolution.

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing::info;

mod api_client;
mod cc_executor;
mod codex_executor;
mod config;
mod context;
mod diff;
mod dispatcher;
mod event_reporter;
mod executor;
mod gates;
mod mcp_client;
mod tools;
mod wo;

/// Minion executor: minimal-loop agent executor and work order dispatcher.
#[derive(Parser, Debug)]
#[command(name = "minion-executor", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run a single work order through the executor.
    Run {
        /// Path to work order YAML file.
        #[arg(long = "wo")]
        work_order: PathBuf,

        /// Path to config YAML file.
        #[arg(long)]
        config: Option<PathBuf>,

        /// Working directory for diff application.
        #[arg(long)]
        working_dir: Option<PathBuf>,

        /// Don't apply diffs — just output the JSON result.
        #[arg(long)]
        dry_run: bool,

        /// Apply diffs to the filesystem after execution.
        #[arg(long)]
        apply_diffs: bool,

        /// Path to Codex CLI binary (overrides config/env).
        #[arg(long)]
        codex_binary: Option<String>,

        /// Agentboard API URL for CC escalation (overrides config).
        #[arg(long)]
        agentboard_url: Option<String>,
    },

    /// Dispatch a group of work orders with dependency resolution.
    Dispatch {
        /// Directory containing WO YAML files.
        #[arg(long)]
        wos: PathBuf,

        /// Path to config YAML file.
        #[arg(long)]
        config: Option<PathBuf>,

        /// Working directory (defaults to current directory).
        #[arg(long)]
        working_dir: Option<PathBuf>,

        /// Maximum parallel executors.
        #[arg(long, default_value = "4")]
        concurrency: usize,

        /// SQLite database path for state persistence.
        #[arg(long)]
        db: Option<PathBuf>,

        /// Maximum group failures before abort.
        #[arg(long, default_value = "3")]
        max_failures: u32,

        /// Path to Codex CLI binary (overrides config/env).
        #[arg(long)]
        codex_binary: Option<String>,

        /// Agentboard API URL for CC escalation (overrides config).
        #[arg(long)]
        agentboard_url: Option<String>,

        /// Override typecheck gate command (e.g. "cargo check").
        #[arg(long)]
        gate_typecheck: Option<String>,

        /// Override lint gate command (e.g. "cargo clippy -- -D warnings").
        #[arg(long)]
        gate_lint: Option<String>,

        /// Override test gate command (e.g. "cargo test {scope}").
        #[arg(long)]
        gate_test: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run {
            work_order,
            config,
            working_dir,
            dry_run,
            apply_diffs,
            codex_binary,
            agentboard_url,
        } => {
            run_single(
                work_order,
                config,
                working_dir,
                dry_run,
                apply_diffs,
                codex_binary,
                agentboard_url,
            )
            .await
        }

        Commands::Dispatch {
            wos,
            config,
            working_dir,
            concurrency,
            db,
            max_failures,
            codex_binary,
            agentboard_url,
            gate_typecheck,
            gate_lint,
            gate_test,
        } => {
            run_dispatch(
                wos,
                config,
                working_dir,
                concurrency,
                db,
                max_failures,
                codex_binary,
                agentboard_url,
                gate_typecheck,
                gate_lint,
                gate_test,
            )
            .await
        }
    }
}

/// Execute a single work order (original behavior).
async fn run_single(
    wo_path: PathBuf,
    config_path: Option<PathBuf>,
    working_dir: Option<PathBuf>,
    dry_run: bool,
    apply_diffs: bool,
    codex_binary: Option<String>,
    agentboard_url: Option<String>,
) -> Result<()> {
    let mut cfg = load_config(config_path.as_deref())?;

    // CLI overrides config.
    if codex_binary.is_some() {
        cfg.codex_binary = codex_binary;
    }
    if agentboard_url.is_some() {
        cfg.agentboard_url = agentboard_url;
    }

    info!(path = %wo_path.display(), "Loading work order from file");
    let work_order = wo::WorkOrder::from_file(&wo_path)?;

    let working_dir = match working_dir {
        Some(ref p) => p.clone(),
        None => std::env::current_dir()?,
    };

    // Route to Codex executor if the WO model starts with "codex".
    let model = if work_order.execution.model.is_empty() {
        &cfg.default_model
    } else {
        &work_order.execution.model
    };

    let result = if model.starts_with("codex") {
        let binary = cfg.resolve_codex_binary()
            .ok_or_else(|| anyhow::anyhow!("Codex model requested but no binary found. Use --codex-binary or set CODEX_BINARY env var."))?;
        let ce = codex_executor::CodexExecutor::new(binary, cfg.codex_max_concurrent);
        use crate::dispatcher::scheduler::Executor;
        ce.execute(&cfg, &work_order, &working_dir).await?
    } else {
        executor::execute(&cfg, &work_order, &working_dir).await?
    };

    if apply_diffs && !dry_run && result.success {
        info!(count = result.diffs.len(), "Applying diffs to filesystem");
        diff::apply_diffs(&result.diffs, &working_dir)?;
    } else if dry_run {
        info!("Dry-run mode: skipping diff application");
    }

    let output = serde_json::to_string_pretty(&result)?;
    println!("{output}");

    if result.success {
        Ok(())
    } else {
        std::process::exit(1);
    }
}

/// Dispatch a group of work orders.
async fn run_dispatch(
    wos_path: PathBuf,
    config_path: Option<PathBuf>,
    working_dir: Option<PathBuf>,
    concurrency: usize,
    db_path: Option<PathBuf>,
    max_failures: u32,
    codex_binary: Option<String>,
    agentboard_url: Option<String>,
    gate_typecheck: Option<String>,
    gate_lint: Option<String>,
    gate_test: Option<String>,
) -> Result<()> {
    let mut cfg = load_config(config_path.as_deref())?;

    // CLI overrides config.
    if codex_binary.is_some() {
        cfg.codex_binary = codex_binary;
    }
    if agentboard_url.is_some() {
        cfg.agentboard_url = agentboard_url;
    }
    if let Some(cmd) = gate_typecheck {
        cfg.gate_commands.typecheck = cmd;
    }
    if let Some(cmd) = gate_lint {
        cfg.gate_commands.lint = cmd;
    }
    if let Some(cmd) = gate_test {
        cfg.gate_commands.test = cmd;
    }

    let working_dir = match working_dir {
        Some(ref p) => p.clone(),
        None => std::env::current_dir()?,
    };

    // Load work orders from directory.
    let work_orders = load_work_orders(&wos_path)?;
    if work_orders.is_empty() {
        bail!("No work order YAML files found in {}", wos_path.display());
    }

    info!(
        count = work_orders.len(),
        path = %wos_path.display(),
        "Loaded work orders"
    );

    let dispatcher_config = dispatcher::DispatcherConfig {
        max_concurrency: concurrency,
        db_path: db_path.unwrap_or_else(|| {
            dirs_next::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".agentboard")
                .join("dispatcher.db")
        }),
        max_group_failures: max_failures,
    };

    let result =
        dispatcher::dispatch_group(&cfg, &dispatcher_config, work_orders, &working_dir).await?;

    let output = serde_json::to_string_pretty(&result)?;
    println!("{output}");

    match result.status {
        dispatcher::state::GroupStatus::Completed => Ok(()),
        _ => std::process::exit(1),
    }
}

/// Load all WO YAML files from a directory.
fn load_work_orders(path: &std::path::Path) -> Result<Vec<wo::WorkOrder>> {
    if !path.is_dir() {
        // Single file — load it directly.
        let wo = wo::WorkOrder::from_file(path)?;
        return Ok(vec![wo]);
    }

    let mut work_orders = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if let Some(ext) = path.extension() {
            if ext == "yaml" || ext == "yml" {
                match wo::WorkOrder::from_file(&path) {
                    Ok(wo) => work_orders.push(wo),
                    Err(e) => {
                        info!(path = %path.display(), error = %e, "Skipping non-WO YAML file");
                    }
                }
            }
        }
    }

    // Sort by ID for deterministic ordering.
    work_orders.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(work_orders)
}

/// Load config from a YAML file, falling back to defaults.
fn load_config(path: Option<&std::path::Path>) -> Result<config::Config> {
    let config_path = path.map(|p| p.to_path_buf()).or_else(|| {
        dirs_next::home_dir().map(|h| h.join(".agentboard").join("minion-executor.yaml"))
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
