//! Dependency graph for work order scheduling.
//!
//! Pure data structure — no async, no IO. Builds a DAG from work order
//! `depends_on` fields and answers "what's ready to fire?" queries.

use std::collections::{HashMap, HashSet, VecDeque};

use anyhow::{bail, Result};

/// Dependency graph over work order IDs.
///
/// Supports cycle detection (Kahn's algorithm) and incremental "ready set"
/// queries as work orders complete.
#[derive(Debug, Clone)]
pub struct DependencyGraph {
    /// WO ID → set of WO IDs it depends on.
    dependencies: HashMap<String, HashSet<String>>,
    /// WO ID → set of WO IDs that depend on it (reverse index).
    dependents: HashMap<String, HashSet<String>>,
    /// All known WO IDs.
    all_ids: HashSet<String>,
}

impl DependencyGraph {
    /// Build the graph from a slice of (wo_id, depends_on) pairs.
    ///
    /// Returns an error if any dependency references an unknown WO ID.
    pub fn build(work_orders: &[(String, Vec<String>)]) -> Result<Self> {
        let all_ids: HashSet<String> = work_orders.iter().map(|(id, _)| id.clone()).collect();

        let mut dependencies: HashMap<String, HashSet<String>> = HashMap::new();
        let mut dependents: HashMap<String, HashSet<String>> = HashMap::new();

        for (id, deps) in work_orders {
            let dep_set: HashSet<String> = deps.iter().cloned().collect();

            // Validate all deps reference known WOs.
            for dep in &dep_set {
                if !all_ids.contains(dep) {
                    bail!(
                        "Work order {id} depends on {dep}, which is not in the work order set"
                    );
                }
            }

            // Build reverse index.
            for dep in &dep_set {
                dependents
                    .entry(dep.clone())
                    .or_default()
                    .insert(id.clone());
            }

            dependencies.insert(id.clone(), dep_set);
        }

        // Ensure every ID has an entry (even if empty).
        for id in &all_ids {
            dependencies.entry(id.clone()).or_default();
            dependents.entry(id.clone()).or_default();
        }

        Ok(Self {
            dependencies,
            dependents,
            all_ids,
        })
    }

    /// Detect cycles using Kahn's algorithm.
    ///
    /// Returns `Some(cycle_members)` if a cycle exists, `None` if the graph is a valid DAG.
    pub fn detect_cycle(&self) -> Option<Vec<String>> {
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        for id in &self.all_ids {
            in_degree.insert(id.as_str(), self.dependencies[id].len());
        }

        let mut queue: VecDeque<&str> = VecDeque::new();
        for (&id, &deg) in &in_degree {
            if deg == 0 {
                queue.push_back(id);
            }
        }

        let mut visited = 0usize;
        while let Some(id) = queue.pop_front() {
            visited += 1;
            if let Some(deps) = self.dependents.get(id) {
                for dep in deps {
                    if let Some(deg) = in_degree.get_mut(dep.as_str()) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(dep.as_str());
                        }
                    }
                }
            }
        }

        if visited == self.all_ids.len() {
            None
        } else {
            // Nodes not visited are part of a cycle.
            let cycle: Vec<String> = in_degree
                .into_iter()
                .filter(|(_, deg)| *deg > 0)
                .map(|(id, _)| id.to_string())
                .collect();
            Some(cycle)
        }
    }

    /// Return a topological ordering of all WO IDs.
    ///
    /// Returns an error if the graph contains a cycle.
    pub fn topological_order(&self) -> Result<Vec<String>> {
        if let Some(cycle) = self.detect_cycle() {
            bail!("Cycle detected involving: {}", cycle.join(", "));
        }

        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        for id in &self.all_ids {
            in_degree.insert(id.as_str(), self.dependencies[id].len());
        }

        let mut queue: VecDeque<&str> = VecDeque::new();
        // Sort initial ready set for deterministic output.
        let mut zero_deg: Vec<&str> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&id, _)| id)
            .collect();
        zero_deg.sort();
        for id in zero_deg {
            queue.push_back(id);
        }

        let mut order = Vec::with_capacity(self.all_ids.len());
        while let Some(id) = queue.pop_front() {
            order.push(id.to_string());
            if let Some(deps) = self.dependents.get(id) {
                let mut newly_ready: Vec<&str> = Vec::new();
                for dep in deps {
                    if let Some(deg) = in_degree.get_mut(dep.as_str()) {
                        *deg -= 1;
                        if *deg == 0 {
                            newly_ready.push(dep.as_str());
                        }
                    }
                }
                // Sort for deterministic output.
                newly_ready.sort();
                for r in newly_ready {
                    queue.push_back(r);
                }
            }
        }

        Ok(order)
    }

    /// Return WO IDs that are ready to fire: all dependencies are in the
    /// `completed` set, and the WO itself is not completed.
    pub fn ready_ids(&self, completed: &HashSet<String>) -> Vec<String> {
        let mut ready = Vec::new();
        for id in &self.all_ids {
            if completed.contains(id) {
                continue;
            }
            let deps = &self.dependencies[id];
            if deps.iter().all(|d| completed.contains(d)) {
                ready.push(id.clone());
            }
        }
        ready.sort(); // deterministic
        ready
    }

    /// Return WO IDs that directly depend on the given WO.
    pub fn dependents_of(&self, wo_id: &str) -> Vec<String> {
        self.dependents
            .get(wo_id)
            .map(|s| {
                let mut v: Vec<String> = s.iter().cloned().collect();
                v.sort();
                v
            })
            .unwrap_or_default()
    }

    /// Total number of work orders in the graph.
    pub fn len(&self) -> usize {
        self.all_ids.len()
    }

    /// Whether the graph is empty.
    pub fn is_empty(&self) -> bool {
        self.all_ids.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_graph() {
        let graph = DependencyGraph::build(&[]).unwrap();
        assert!(graph.is_empty());
        assert!(graph.detect_cycle().is_none());
        assert!(graph.ready_ids(&HashSet::new()).is_empty());
        assert!(graph.topological_order().unwrap().is_empty());
    }

    #[test]
    fn test_single_wo_no_deps() {
        let graph = DependencyGraph::build(&[("A".into(), vec![])]).unwrap();
        assert_eq!(graph.len(), 1);
        assert!(graph.detect_cycle().is_none());

        let ready = graph.ready_ids(&HashSet::new());
        assert_eq!(ready, vec!["A"]);

        let order = graph.topological_order().unwrap();
        assert_eq!(order, vec!["A"]);
    }

    #[test]
    fn test_linear_chain() {
        // C depends on B, B depends on A
        let graph = DependencyGraph::build(&[
            ("A".into(), vec![]),
            ("B".into(), vec!["A".into()]),
            ("C".into(), vec!["B".into()]),
        ])
        .unwrap();

        assert!(graph.detect_cycle().is_none());

        // Initially only A is ready.
        let ready = graph.ready_ids(&HashSet::new());
        assert_eq!(ready, vec!["A"]);

        // After A completes, B is ready.
        let completed: HashSet<String> = ["A".into()].into();
        let ready = graph.ready_ids(&completed);
        assert_eq!(ready, vec!["B"]);

        // After A and B complete, C is ready.
        let completed: HashSet<String> = ["A".into(), "B".into()].into();
        let ready = graph.ready_ids(&completed);
        assert_eq!(ready, vec!["C"]);

        let order = graph.topological_order().unwrap();
        assert_eq!(order, vec!["A", "B", "C"]);
    }

    #[test]
    fn test_diamond() {
        // D depends on B and C; B and C depend on A.
        let graph = DependencyGraph::build(&[
            ("A".into(), vec![]),
            ("B".into(), vec!["A".into()]),
            ("C".into(), vec!["A".into()]),
            ("D".into(), vec!["B".into(), "C".into()]),
        ])
        .unwrap();

        assert!(graph.detect_cycle().is_none());

        // Initially only A.
        let ready = graph.ready_ids(&HashSet::new());
        assert_eq!(ready, vec!["A"]);

        // After A: B and C ready in parallel.
        let completed: HashSet<String> = ["A".into()].into();
        let ready = graph.ready_ids(&completed);
        assert_eq!(ready, vec!["B", "C"]);

        // After A+B: D not ready yet (C still pending).
        let completed: HashSet<String> = ["A".into(), "B".into()].into();
        let ready = graph.ready_ids(&completed);
        assert_eq!(ready, vec!["C"]);

        // After A+B+C: D ready.
        let completed: HashSet<String> = ["A".into(), "B".into(), "C".into()].into();
        let ready = graph.ready_ids(&completed);
        assert_eq!(ready, vec!["D"]);
    }

    #[test]
    fn test_parallel_no_deps() {
        let graph = DependencyGraph::build(&[
            ("A".into(), vec![]),
            ("B".into(), vec![]),
            ("C".into(), vec![]),
        ])
        .unwrap();

        let ready = graph.ready_ids(&HashSet::new());
        assert_eq!(ready, vec!["A", "B", "C"]);
    }

    #[test]
    fn test_cycle_detected() {
        let graph = DependencyGraph::build(&[
            ("A".into(), vec!["B".into()]),
            ("B".into(), vec!["A".into()]),
        ])
        .unwrap();

        let cycle = graph.detect_cycle();
        assert!(cycle.is_some());
        let cycle = cycle.unwrap();
        assert!(cycle.contains(&"A".to_string()));
        assert!(cycle.contains(&"B".to_string()));

        assert!(graph.topological_order().is_err());
    }

    #[test]
    fn test_three_node_cycle() {
        let graph = DependencyGraph::build(&[
            ("A".into(), vec!["C".into()]),
            ("B".into(), vec!["A".into()]),
            ("C".into(), vec!["B".into()]),
        ])
        .unwrap();

        assert!(graph.detect_cycle().is_some());
    }

    #[test]
    fn test_unknown_dependency_error() {
        let result = DependencyGraph::build(&[("A".into(), vec!["X".into()])]);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("X"));
        assert!(err.contains("not in the work order set"));
    }

    #[test]
    fn test_dependents_of() {
        let graph = DependencyGraph::build(&[
            ("A".into(), vec![]),
            ("B".into(), vec!["A".into()]),
            ("C".into(), vec!["A".into()]),
        ])
        .unwrap();

        let deps = graph.dependents_of("A");
        assert_eq!(deps, vec!["B", "C"]);
        assert!(graph.dependents_of("B").is_empty());
    }

    #[test]
    fn test_self_dependency() {
        let result = DependencyGraph::build(&[("A".into(), vec!["A".into()])]);
        // Self-dep is valid to build, but cycle detection catches it.
        let graph = result.unwrap();
        assert!(graph.detect_cycle().is_some());
    }

    #[test]
    fn test_ready_excludes_completed() {
        let graph = DependencyGraph::build(&[
            ("A".into(), vec![]),
            ("B".into(), vec![]),
        ])
        .unwrap();

        let completed: HashSet<String> = ["A".into()].into();
        let ready = graph.ready_ids(&completed);
        // A is completed so not in ready set; B is still ready.
        assert_eq!(ready, vec!["B"]);
    }
}
