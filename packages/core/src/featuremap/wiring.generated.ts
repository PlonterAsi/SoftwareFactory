// Generated from the code by packages/core/scripts/wiring.mjs. Do not edit: run `npm run wiring -w @sf/core`.
export interface FileWiring {
  lines: number;
  /** Source files this one imports. */
  imports?: string[];
  /** Event types it appends to the log. */
  writes?: string[];
  /** Event types it names without writing them (it reads or reacts to them); "x.*" is a prefix. */
  reads?: string[];
  /** API areas a core file answers. */
  serves?: string[];
  /** API areas a Bridge file calls. */
  calls?: string[];
  /** Tables it creates. */
  creates?: string[];
  /** Tables it queries but another file creates. */
  sql?: string[];
}
export const WIRING: { events: string[]; tables: string[]; files: Record<string, FileWiring> } = {
 "events": [
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.retried",
  "agent.run.started",
  "agent.verdict",
  "app.update.held",
  "app.update.started",
  "app.updated",
  "base.archived",
  "base.created",
  "base.opened",
  "base.renamed",
  "bay.agent.retired",
  "bay.agent.saved",
  "bay.assign",
  "bay.test",
  "bay.visual",
  "brain.principle.reset",
  "brain.principle.saved",
  "brain.suggestion.dismissed",
  "bridge.seen",
  "drop.filed",
  "drop.skipped",
  "factory.attempt",
  "factory.budget",
  "factory.continued",
  "factory.council",
  "factory.discovery",
  "factory.evaluation",
  "factory.fastgate",
  "factory.feature",
  "factory.files",
  "factory.gate",
  "factory.ladder",
  "factory.links",
  "factory.links.blanked",
  "factory.links.found",
  "factory.links.search",
  "factory.plan",
  "factory.plan.gaps",
  "factory.recall",
  "factory.repair",
  "factory.repair.stopped",
  "factory.research",
  "factory.retro",
  "factory.review",
  "factory.review.open",
  "factory.run.finished",
  "factory.run.resumed",
  "factory.run.started",
  "factory.screen.look",
  "factory.screens",
  "factory.sentback.resumed",
  "factory.station",
  "factory.tests",
  "factory.tests.disputed",
  "factory.tests.dryrun",
  "factory.tests.locked",
  "factory.ui",
  "factory.visual",
  "featuremap.record.reset",
  "featuremap.record.saved",
  "improve.proposal",
  "improve.proposal.accepted",
  "improve.proposal.decided",
  "improve.proposal.linked",
  "improve.seat",
  "improve.session",
  "improve.visual",
  "integration.briefed",
  "integration.decided",
  "integration.failed",
  "integration.installed",
  "integration.removed",
  "integration.requested",
  "integration.used",
  "launch.exited",
  "launch.started",
  "launch.stopped",
  "launch.url",
  "order.briefing",
  "order.conflict",
  "order.conflict.resolved",
  "order.fragment",
  "order.fragment.moved",
  "order.fragment.pinned",
  "order.ingest",
  "order.node",
  "order.sweep",
  "order.sweep.undone",
  "order.visual",
  "plugin.data",
  "plugin.disabled",
  "plugin.emitted",
  "plugin.enabled",
  "plugin.failed",
  "plugin.installed",
  "plugin.log",
  "plugin.removed",
  "project.budget",
  "project.created",
  "project.linked",
  "project.unlinked",
  "project.updated",
  "repo.explore.finished",
  "repo.explore.started",
  "repo.explore.station",
  "repo.import.failed",
  "repo.import.started",
  "repo.imported",
  "repo.mapped",
  "repo.module.understood",
  "repo.suggestion",
  "settings.changed",
  "signal.captured",
  "store.migrated",
  "store.rebuilt",
  "ticket.branch",
  "ticket.edited",
  "ticket.keyed",
  "ticket.line.moved",
  "ticket.linked",
  "ticket.noted",
  "ticket.opened",
  "ticket.pr",
  "ticket.requested",
  "ticket.run",
  "ticket.step"
 ],
 "tables": [
  "agent_runs",
  "agent_verdicts",
  "app_versions",
  "artifacts",
  "base_events",
  "bases",
  "bay_agent_versions",
  "bay_agents",
  "bay_slots",
  "bay_tests",
  "brain_principles",
  "code_maps",
  "code_modules",
  "code_suggestions",
  "council_seats",
  "council_sessions",
  "drops",
  "events",
  "factory_runs",
  "feature_records",
  "improve_proposals",
  "improve_sessions",
  "integrations",
  "launch_sessions",
  "order_conflicts",
  "order_fragments",
  "order_nodes",
  "plugin_data",
  "plugins",
  "project_links",
  "projections",
  "projects",
  "recall_fts",
  "repo_imports",
  "reviews",
  "schema_migrations",
  "settings",
  "signal_fts",
  "signals",
  "ticket_keys",
  "ticket_links",
  "ticket_notes",
  "tickets"
 ],
 "files": {
  "packages/core/src/agents.ts": {
   "lines": 55,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/setup.ts"
   ],
   "writes": [
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.retried",
    "agent.run.started"
   ],
   "sql": [
    "agent_runs"
   ]
  },
  "packages/core/src/bases/host.ts": {
   "lines": 119,
   "imports": [
    "packages/core/src/bases/registry.ts"
   ],
   "serves": [
    "/api/bases",
    "/api/events"
   ]
  },
  "packages/core/src/bases/registry.ts": {
   "lines": 234,
   "writes": [
    "base.archived",
    "base.created",
    "base.opened",
    "base.renamed"
   ],
   "creates": [
    "base_events",
    "bases"
   ],
   "sql": [
    "agent_runs",
    "events",
    "factory_runs",
    "projects",
    "signals"
   ]
  },
  "packages/core/src/bay/agentfile.ts": {
   "lines": 157
  },
  "packages/core/src/bay/bay.ts": {
   "lines": 402,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/bay/builtin.ts",
    "packages/core/src/bay/kits.ts",
    "packages/core/src/bay/tables.ts",
    "packages/core/src/brain/brain.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/council.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/factory/discovery.ts",
    "packages/core/src/factory/evaluate.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/imports/crew.ts",
    "packages/core/src/improve/lenses.ts",
    "packages/core/src/order/archivist.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/runtime.ts"
   ],
   "writes": [
    "bay.agent.retired",
    "bay.agent.saved",
    "bay.assign",
    "bay.test",
    "bay.visual"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.started",
    "agent.verdict"
   ]
  },
  "packages/core/src/bay/builtin.ts": {
   "lines": 313,
   "imports": [
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/brain/brain.ts",
    "packages/core/src/order/archivist.ts"
   ]
  },
  "packages/core/src/bay/kits.ts": {
   "lines": 165
  },
  "packages/core/src/bay/tables.ts": {
   "lines": 163,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "agent.verdict",
    "bay.agent.retired",
    "bay.agent.saved",
    "bay.assign",
    "bay.test",
    "factory.council",
    "factory.review"
   ],
   "creates": [
    "agent_verdicts",
    "bay_agent_versions",
    "bay_agents",
    "bay_slots",
    "bay_tests",
    "council_seats",
    "council_sessions",
    "reviews"
   ]
  },
  "packages/core/src/brain/brain.ts": {
   "lines": 174,
   "imports": [
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/events.ts",
    "packages/core/src/store/projections.ts"
   ],
   "writes": [
    "brain.principle.reset",
    "brain.principle.saved"
   ],
   "creates": [
    "brain_principles"
   ]
  },
  "packages/core/src/brain/learn.ts": {
   "lines": 98,
   "imports": [
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/brain/brain.ts",
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts"
   ],
   "writes": [
    "brain.suggestion.dismissed"
   ],
   "reads": [
    "brain.principle.reset",
    "brain.principle.saved"
   ],
   "sql": [
    "agent_runs"
   ]
  },
  "packages/core/src/brain/recall.ts": {
   "lines": 81,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "factory.council",
    "factory.plan",
    "improve.proposal",
    "order.fragment",
    "signal.captured",
    "ticket.noted",
    "ticket.opened"
   ],
   "creates": [
    "recall_fts"
   ]
  },
  "packages/core/src/brain/routes.ts": {
   "lines": 64,
   "imports": [
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/bay/builtin.ts",
    "packages/core/src/brain/brain.ts",
    "packages/core/src/brain/learn.ts",
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts"
   ]
  },
  "packages/core/src/bridge/drop.ts": {
   "lines": 112,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/signals.ts"
   ],
   "writes": [
    "drop.filed",
    "drop.skipped"
   ],
   "sql": [
    "drops"
   ]
  },
  "packages/core/src/bridge/status.ts": {
   "lines": 113,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts"
   ],
   "reads": [
    "factory.gate"
   ],
   "sql": [
    "agent_runs",
    "drops",
    "events",
    "factory_runs",
    "improve_proposals"
   ]
  },
  "packages/core/src/bridge/tables.ts": {
   "lines": 80,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "app.updated",
    "drop.filed",
    "drop.skipped",
    "settings.changed"
   ],
   "creates": [
    "app_versions",
    "drops",
    "settings"
   ]
  },
  "packages/core/src/chat/routes.ts": {
   "lines": 79,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/projects/tables.ts"
   ],
   "sql": [
    "project_links"
   ]
  },
  "packages/core/src/events.ts": {
   "lines": 297,
   "imports": [
    "packages/core/src/store/cache.ts",
    "packages/core/src/store/migrations.ts",
    "packages/core/src/store/projections.ts",
    "packages/core/src/store/tables.ts"
   ],
   "writes": [
    "store.migrated",
    "store.rebuilt"
   ],
   "sql": [
    "events",
    "projections",
    "signal_fts"
   ]
  },
  "packages/core/src/factory/appagent.ts": {
   "lines": 60,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/runtime.ts"
   ],
   "sql": [
    "agent_runs"
   ]
  },
  "packages/core/src/factory/appkit.ts": {
   "lines": 219,
   "imports": [
    "packages/core/src/factory/kitFiles.ts",
    "packages/core/src/factory/uicheck.ts",
    "packages/core/src/launch/launcher.ts"
   ]
  },
  "packages/core/src/factory/council.ts": {
   "lines": 95,
   "imports": [
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/order/text.ts"
   ]
  },
  "packages/core/src/factory/crew.ts": {
   "lines": 71,
   "imports": [
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/bay/builtin.ts",
    "packages/core/src/bay/kits.ts",
    "packages/core/src/brain/brain.ts"
   ]
  },
  "packages/core/src/factory/cycles.ts": {
   "lines": 89,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/factory/retro.ts"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "app.updated",
    "factory.discovery",
    "factory.evaluation",
    "factory.retro",
    "factory.run.finished",
    "factory.run.resumed",
    "factory.run.started"
   ]
  },
  "packages/core/src/factory/discovery.ts": {
   "lines": 263
  },
  "packages/core/src/factory/evaluate.ts": {
   "lines": 144,
   "imports": [
    "packages/core/src/factory/discovery.ts",
    "packages/core/src/factory/features.ts"
   ]
  },
  "packages/core/src/factory/features.ts": {
   "lines": 168,
   "imports": [
    "packages/core/src/factory/discovery.ts",
    "packages/core/src/factory/loop.ts"
   ]
  },
  "packages/core/src/factory/kitFiles.ts": {
   "lines": 10
  },
  "packages/core/src/factory/linkcheck.ts": {
   "lines": 151,
   "imports": [
    "packages/core/src/factory/workspace.ts"
   ]
  },
  "packages/core/src/factory/loop.ts": {
   "lines": 1959,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/brain/recall.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/appkit.ts",
    "packages/core/src/factory/council.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/factory/discovery.ts",
    "packages/core/src/factory/evaluate.ts",
    "packages/core/src/factory/features.ts",
    "packages/core/src/factory/linkcheck.ts",
    "packages/core/src/factory/retro.ts",
    "packages/core/src/factory/screencheck.ts",
    "packages/core/src/factory/stoprules.ts",
    "packages/core/src/factory/testcheck.ts",
    "packages/core/src/factory/trim.ts",
    "packages/core/src/factory/uicheck.ts",
    "packages/core/src/factory/visualize.ts",
    "packages/core/src/factory/workbench.ts",
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/safety/gates.ts",
    "packages/core/src/safety/secrets.ts",
    "packages/core/src/safety/testguard.ts",
    "packages/core/src/signals.ts"
   ],
   "writes": [
    "agent.run.failed",
    "agent.verdict",
    "factory.attempt",
    "factory.budget",
    "factory.continued",
    "factory.council",
    "factory.discovery",
    "factory.evaluation",
    "factory.fastgate",
    "factory.feature",
    "factory.files",
    "factory.gate",
    "factory.ladder",
    "factory.links",
    "factory.links.blanked",
    "factory.links.found",
    "factory.links.search",
    "factory.plan",
    "factory.plan.gaps",
    "factory.recall",
    "factory.repair",
    "factory.repair.stopped",
    "factory.research",
    "factory.retro",
    "factory.review",
    "factory.review.open",
    "factory.run.finished",
    "factory.run.resumed",
    "factory.run.started",
    "factory.screen.look",
    "factory.screens",
    "factory.sentback.resumed",
    "factory.station",
    "factory.tests",
    "factory.tests.disputed",
    "factory.tests.dryrun",
    "factory.tests.locked",
    "factory.ui",
    "factory.visual"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.started"
   ],
   "sql": [
    "factory_runs",
    "project_links"
   ]
  },
  "packages/core/src/factory/retro.ts": {
   "lines": 196,
   "imports": [
    "packages/core/src/events.ts"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.retried",
    "agent.verdict",
    "factory.attempt",
    "factory.continued",
    "factory.discovery",
    "factory.evaluation",
    "factory.feature",
    "factory.ladder",
    "factory.links",
    "factory.links.blanked",
    "factory.links.found",
    "factory.plan",
    "factory.plan.gaps",
    "factory.repair",
    "factory.repair.stopped",
    "factory.research",
    "factory.retro",
    "factory.review.open",
    "factory.screen.look",
    "factory.screens",
    "factory.station",
    "factory.tests.disputed"
   ]
  },
  "packages/core/src/factory/screencheck.ts": {
   "lines": 168,
   "imports": [
    "packages/core/src/launch/launcher.ts"
   ]
  },
  "packages/core/src/factory/stoprules.ts": {
   "lines": 44
  },
  "packages/core/src/factory/testcheck.ts": {
   "lines": 109,
   "imports": [
    "packages/core/src/factory/workspace.ts"
   ]
  },
  "packages/core/src/factory/trim.ts": {
   "lines": 31
  },
  "packages/core/src/factory/uicheck.ts": {
   "lines": 141,
   "imports": [
    "packages/core/src/factory/workspace.ts"
   ]
  },
  "packages/core/src/factory/visualize.ts": {
   "lines": 61,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/factory/loop.ts"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.started",
    "factory.council",
    "factory.discovery",
    "factory.evaluation",
    "factory.feature",
    "factory.files",
    "factory.plan",
    "factory.review",
    "factory.station",
    "factory.tests",
    "signal.captured"
   ]
  },
  "packages/core/src/factory/workbench.ts": {
   "lines": 112,
   "imports": [
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/runtime.ts"
   ]
  },
  "packages/core/src/factory/workspace.ts": {
   "lines": 227,
   "imports": [
    "packages/core/src/launch/launcher.ts"
   ]
  },
  "packages/core/src/factory-cli.ts": {
   "lines": 48,
   "imports": [
    "packages/core/src/bay/bay.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/runtime.ts"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "factory.council",
    "factory.gate",
    "factory.review",
    "factory.run.finished",
    "factory.station",
    "factory.tests"
   ]
  },
  "packages/core/src/featuremap/map.ts": {
   "lines": 343,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/featuremap/records.ts",
    "packages/core/src/featuremap/wiring.generated.ts",
    "packages/core/src/store/projections.ts"
   ],
   "writes": [
    "featuremap.record.reset",
    "featuremap.record.saved"
   ],
   "reads": [
    "factory.budget",
    "factory.council",
    "factory.discovery",
    "factory.evaluation",
    "factory.fastgate",
    "factory.feature",
    "factory.gate",
    "factory.links",
    "factory.plan",
    "factory.recall",
    "factory.research",
    "factory.retro",
    "factory.screen.look",
    "factory.screens",
    "factory.tests",
    "factory.tests.dryrun",
    "factory.tests.locked",
    "factory.visual",
    "launch.started",
    "project.budget",
    "ticket.branch"
   ],
   "creates": [
    "feature_records"
   ],
   "sql": [
    "agent_runs",
    "events"
   ]
  },
  "packages/core/src/featuremap/records.ts": {
   "lines": 430,
   "serves": [
    "/api/agent",
    "/api/apps",
    "/api/bases",
    "/api/bay",
    "/api/brain",
    "/api/chat",
    "/api/cost",
    "/api/events",
    "/api/factory",
    "/api/feature-map",
    "/api/health",
    "/api/imports",
    "/api/improve",
    "/api/integrations",
    "/api/launch",
    "/api/open",
    "/api/order",
    "/api/plugins",
    "/api/presence",
    "/api/projects",
    "/api/runners",
    "/api/setup",
    "/api/signals",
    "/api/since",
    "/api/store",
    "/api/tickets",
    "/api/updates"
   ]
  },
  "packages/core/src/featuremap/routes.ts": {
   "lines": 35,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/featuremap/map.ts"
   ]
  },
  "packages/core/src/featuremap/wiring.generated.ts": {
   "lines": 2479
  },
  "packages/core/src/imports/crew.ts": {
   "lines": 176,
   "imports": [
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/imports/scan.ts"
   ]
  },
  "packages/core/src/imports/explorer.ts": {
   "lines": 376,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/imports/crew.ts",
    "packages/core/src/imports/scan.ts",
    "packages/core/src/imports/tables.ts",
    "packages/core/src/projects/service.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/setup.ts"
   ],
   "writes": [
    "repo.explore.finished",
    "repo.explore.started",
    "repo.explore.station",
    "repo.import.failed",
    "repo.import.started",
    "repo.imported",
    "repo.mapped",
    "repo.module.understood",
    "repo.suggestion"
   ],
   "sql": [
    "code_maps",
    "code_modules",
    "code_suggestions",
    "events",
    "projects",
    "repo_imports"
   ]
  },
  "packages/core/src/imports/routes.ts": {
   "lines": 69,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/imports/explorer.ts",
    "packages/core/src/improve/council.ts",
    "packages/core/src/projects/service.ts"
   ],
   "serves": [
    "/api/imports"
   ]
  },
  "packages/core/src/imports/scan.ts": {
   "lines": 385
  },
  "packages/core/src/imports/tables.ts": {
   "lines": 137,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "improve.proposal",
    "improve.proposal.accepted",
    "improve.proposal.decided",
    "repo.explore.finished",
    "repo.explore.started",
    "repo.import.failed",
    "repo.import.started",
    "repo.imported",
    "repo.mapped",
    "repo.module.understood",
    "repo.suggestion"
   ],
   "creates": [
    "code_maps",
    "code_modules",
    "code_suggestions",
    "repo_imports"
   ]
  },
  "packages/core/src/improve/council.ts": {
   "lines": 478,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/improve/lenses.ts",
    "packages/core/src/improve/tables.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/projects/service.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/signals.ts"
   ],
   "writes": [
    "agent.verdict",
    "improve.proposal",
    "improve.proposal.accepted",
    "improve.proposal.decided",
    "improve.proposal.linked",
    "improve.seat",
    "improve.session",
    "improve.visual"
   ],
   "reads": [
    "repo.suggestion"
   ],
   "sql": [
    "agent_runs",
    "council_sessions",
    "events",
    "factory_runs",
    "improve_proposals",
    "improve_sessions"
   ]
  },
  "packages/core/src/improve/lenses.ts": {
   "lines": 112,
   "imports": [
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/order/text.ts"
   ]
  },
  "packages/core/src/improve/tables.ts": {
   "lines": 87,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "improve.proposal",
    "improve.proposal.decided",
    "improve.proposal.linked",
    "improve.session"
   ],
   "creates": [
    "improve_proposals",
    "improve_sessions"
   ]
  },
  "packages/core/src/index.ts": {
   "lines": 76,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bases/host.ts",
    "packages/core/src/bases/registry.ts",
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/bay/builtin.ts",
    "packages/core/src/bay/tables.ts",
    "packages/core/src/brain/brain.ts",
    "packages/core/src/brain/learn.ts",
    "packages/core/src/bridge/drop.ts",
    "packages/core/src/bridge/status.ts",
    "packages/core/src/bridge/tables.ts",
    "packages/core/src/chat/routes.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/appkit.ts",
    "packages/core/src/factory/council.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/factory/uicheck.ts",
    "packages/core/src/factory/visualize.ts",
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/featuremap/map.ts",
    "packages/core/src/featuremap/records.ts",
    "packages/core/src/imports/crew.ts",
    "packages/core/src/imports/explorer.ts",
    "packages/core/src/imports/routes.ts",
    "packages/core/src/imports/scan.ts",
    "packages/core/src/imports/tables.ts",
    "packages/core/src/improve/council.ts",
    "packages/core/src/improve/lenses.ts",
    "packages/core/src/improve/tables.ts",
    "packages/core/src/integrations/assess.ts",
    "packages/core/src/integrations/routes.ts",
    "packages/core/src/integrations/service.ts",
    "packages/core/src/integrations/tables.ts",
    "packages/core/src/launch/detect.ts",
    "packages/core/src/launch/files.ts",
    "packages/core/src/launch/launcher.ts",
    "packages/core/src/launch/quick.ts",
    "packages/core/src/launch/routes.ts",
    "packages/core/src/launch/static.ts",
    "packages/core/src/launch/tables.ts",
    "packages/core/src/launch/usage.ts",
    "packages/core/src/order/archivist.ts",
    "packages/core/src/order/engine.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/order/text.ts",
    "packages/core/src/plugins/host.ts",
    "packages/core/src/plugins/manifest.ts",
    "packages/core/src/plugins/routes.ts",
    "packages/core/src/plugins/runner.ts",
    "packages/core/src/plugins/tables.ts",
    "packages/core/src/projects/model.ts",
    "packages/core/src/projects/routes.ts",
    "packages/core/src/projects/service.ts",
    "packages/core/src/projects/tables.ts",
    "packages/core/src/runners/manager.ts",
    "packages/core/src/runners/routes.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/server.ts",
    "packages/core/src/setup.ts",
    "packages/core/src/signals.ts",
    "packages/core/src/store/cache.ts",
    "packages/core/src/store/inspect.ts",
    "packages/core/src/store/migrations.ts",
    "packages/core/src/store/projections.ts",
    "packages/core/src/store/tables.ts",
    "packages/core/src/tickets/capture.ts",
    "packages/core/src/tickets/github.ts",
    "packages/core/src/tickets/intake.ts",
    "packages/core/src/tickets/model.ts",
    "packages/core/src/tickets/repowork.ts",
    "packages/core/src/tickets/tables.ts",
    "packages/core/src/tickets/tickets.ts"
   ]
  },
  "packages/core/src/integrations/assess.ts": {
   "lines": 181,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/imports/explorer.ts",
    "packages/core/src/plugins/manifest.ts",
    "packages/core/src/projects/service.ts"
   ],
   "reads": [
    "factory.tests"
   ],
   "sql": [
    "factory_runs"
   ]
  },
  "packages/core/src/integrations/routes.ts": {
   "lines": 89,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/integrations/assess.ts",
    "packages/core/src/integrations/service.ts",
    "packages/core/src/projects/service.ts"
   ],
   "serves": [
    "/api/integrations"
   ]
  },
  "packages/core/src/integrations/service.ts": {
   "lines": 258,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/integrations/assess.ts",
    "packages/core/src/integrations/tables.ts",
    "packages/core/src/launch/detect.ts",
    "packages/core/src/launch/launcher.ts",
    "packages/core/src/plugins/host.ts",
    "packages/core/src/projects/service.ts"
   ],
   "writes": [
    "integration.briefed",
    "integration.decided",
    "integration.failed",
    "integration.installed",
    "integration.removed",
    "integration.requested",
    "integration.used"
   ],
   "sql": [
    "integrations"
   ]
  },
  "packages/core/src/integrations/tables.ts": {
   "lines": 95,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "integration.briefed",
    "integration.decided",
    "integration.failed",
    "integration.installed",
    "integration.removed",
    "integration.requested",
    "integration.used"
   ],
   "creates": [
    "integrations"
   ]
  },
  "packages/core/src/launch/detect.ts": {
   "lines": 202
  },
  "packages/core/src/launch/files.ts": {
   "lines": 224,
   "imports": [
    "packages/core/src/launch/static.ts"
   ]
  },
  "packages/core/src/launch/launcher.ts": {
   "lines": 369,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/launch/detect.ts",
    "packages/core/src/launch/tables.ts"
   ],
   "writes": [
    "launch.exited",
    "launch.started",
    "launch.stopped",
    "launch.url"
   ],
   "reads": [
    "project.updated"
   ],
   "sql": [
    "launch_sessions"
   ]
  },
  "packages/core/src/launch/quick.ts": {
   "lines": 60,
   "imports": [
    "packages/core/src/launch/detect.ts",
    "packages/core/src/launch/files.ts",
    "packages/core/src/launch/usage.ts"
   ]
  },
  "packages/core/src/launch/routes.ts": {
   "lines": 281,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/launch/detect.ts",
    "packages/core/src/launch/files.ts",
    "packages/core/src/launch/launcher.ts",
    "packages/core/src/launch/quick.ts",
    "packages/core/src/launch/static.ts",
    "packages/core/src/launch/usage.ts",
    "packages/core/src/projects/service.ts"
   ],
   "serves": [
    "/api/launch"
   ],
   "sql": [
    "events",
    "factory_runs",
    "launch_sessions",
    "project_links",
    "projects",
    "repo_imports"
   ]
  },
  "packages/core/src/launch/static.ts": {
   "lines": 59
  },
  "packages/core/src/launch/tables.ts": {
   "lines": 62,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "launch.exited",
    "launch.started",
    "launch.url"
   ],
   "creates": [
    "launch_sessions"
   ]
  },
  "packages/core/src/launch/usage.ts": {
   "lines": 265,
   "imports": [
    "packages/core/src/launch/detect.ts"
   ]
  },
  "packages/core/src/order/archivist.ts": {
   "lines": 212,
   "imports": [
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/order/text.ts"
   ]
  },
  "packages/core/src/order/engine.ts": {
   "lines": 374,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/order/archivist.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/order/text.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/store/tables.ts"
   ],
   "writes": [
    "agent.verdict",
    "order.briefing",
    "order.conflict",
    "order.conflict.resolved",
    "order.fragment",
    "order.fragment.moved",
    "order.fragment.pinned",
    "order.ingest",
    "order.node",
    "order.sweep",
    "order.sweep.undone",
    "order.visual"
   ]
  },
  "packages/core/src/order/model.ts": {
   "lines": 313,
   "imports": [
    "packages/core/src/events.ts"
   ],
   "reads": [
    "order.briefing",
    "order.conflict",
    "order.conflict.resolved",
    "order.fragment",
    "order.fragment.moved",
    "order.fragment.pinned",
    "order.ingest",
    "order.node",
    "order.sweep",
    "order.sweep.undone",
    "order.visual",
    "signal.captured"
   ]
  },
  "packages/core/src/order/text.ts": {
   "lines": 101
  },
  "packages/core/src/order-cli.ts": {
   "lines": 80,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/order/engine.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/signals.ts"
   ]
  },
  "packages/core/src/plugins/host.ts": {
   "lines": 447,
   "imports": [
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/events.ts",
    "packages/core/src/launch/launcher.ts",
    "packages/core/src/plugins/manifest.ts",
    "packages/core/src/plugins/runner.ts",
    "packages/core/src/plugins/tables.ts",
    "packages/core/src/projects/service.ts"
   ],
   "writes": [
    "plugin.data",
    "plugin.disabled",
    "plugin.emitted",
    "plugin.enabled",
    "plugin.failed",
    "plugin.installed",
    "plugin.log",
    "plugin.removed"
   ],
   "reads": [
    "agent.run.*",
    "factory.*",
    "factory.run.started",
    "order.conflict",
    "order.fragment",
    "order.node",
    "plugin.*",
    "project.*"
   ],
   "sql": [
    "events",
    "plugin_data",
    "plugins"
   ]
  },
  "packages/core/src/plugins/manifest.ts": {
   "lines": 118,
   "reads": [
    "factory.run.finished"
   ]
  },
  "packages/core/src/plugins/routes.ts": {
   "lines": 103,
   "imports": [
    "packages/core/src/plugins/host.ts",
    "packages/core/src/plugins/manifest.ts",
    "packages/core/src/plugins/runner.ts"
   ],
   "serves": [
    "/api/plugins"
   ]
  },
  "packages/core/src/plugins/runner.ts": {
   "lines": 130
  },
  "packages/core/src/plugins/tables.ts": {
   "lines": 91,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "plugin.data",
    "plugin.disabled",
    "plugin.enabled",
    "plugin.failed",
    "plugin.installed",
    "plugin.removed"
   ],
   "creates": [
    "plugin_data",
    "plugins"
   ]
  },
  "packages/core/src/projects/budget.ts": {
   "lines": 121,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/projects/service.ts"
   ],
   "writes": [
    "project.budget"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "factory.budget",
    "factory.run.finished",
    "factory.run.resumed",
    "factory.run.started"
   ]
  },
  "packages/core/src/projects/model.ts": {
   "lines": 227,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts"
   ],
   "reads": [
    "factory.plan",
    "factory.run.started",
    "order.node",
    "project.created",
    "project.linked",
    "project.unlinked",
    "project.updated",
    "signal.captured"
   ]
  },
  "packages/core/src/projects/routes.ts": {
   "lines": 123,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/order/engine.ts",
    "packages/core/src/projects/budget.ts",
    "packages/core/src/projects/service.ts"
   ],
   "reads": [
    "factory.run.finished"
   ],
   "serves": [
    "/api/projects"
   ]
  },
  "packages/core/src/projects/service.ts": {
   "lines": 280,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/projects/model.ts",
    "packages/core/src/projects/tables.ts"
   ],
   "writes": [
    "project.created",
    "project.linked",
    "project.unlinked",
    "project.updated"
   ],
   "sql": [
    "agent_runs",
    "artifacts",
    "factory_runs",
    "order_conflicts",
    "order_fragments",
    "order_nodes",
    "project_links",
    "projects"
   ]
  },
  "packages/core/src/projects/tables.ts": {
   "lines": 53,
   "imports": [
    "packages/core/src/projects/model.ts",
    "packages/core/src/store/projections.ts",
    "packages/core/src/store/tables.ts"
   ],
   "reads": [
    "factory.plan",
    "factory.run.started",
    "order.node",
    "order.sweep",
    "order.sweep.undone",
    "project.*"
   ],
   "creates": [
    "project_links",
    "projects"
   ]
  },
  "packages/core/src/runners/manager.ts": {
   "lines": 710,
   "imports": [
    "packages/core/src/tickets/github.ts"
   ]
  },
  "packages/core/src/runners/routes.ts": {
   "lines": 76,
   "imports": [
    "packages/core/src/runners/manager.ts"
   ],
   "serves": [
    "/api/runners"
   ]
  },
  "packages/core/src/runtime.ts": {
   "lines": 444,
   "imports": [
    "packages/core/src/launch/launcher.ts",
    "packages/core/src/safety/secrets.ts"
   ]
  },
  "packages/core/src/safety/gates.ts": {
   "lines": 79,
   "imports": [
    "packages/core/src/factory/trim.ts",
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/safety/secrets.ts"
   ]
  },
  "packages/core/src/safety/secrets.ts": {
   "lines": 87
  },
  "packages/core/src/safety/testguard.ts": {
   "lines": 72,
   "imports": [
    "packages/core/src/factory/workspace.ts"
   ]
  },
  "packages/core/src/server.ts": {
   "lines": 879,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bases/host.ts",
    "packages/core/src/bases/registry.ts",
    "packages/core/src/bay/agentfile.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/bay/kits.ts",
    "packages/core/src/brain/routes.ts",
    "packages/core/src/bridge/drop.ts",
    "packages/core/src/bridge/status.ts",
    "packages/core/src/bridge/tables.ts",
    "packages/core/src/chat/routes.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/appagent.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/factory/cycles.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/featuremap/routes.ts",
    "packages/core/src/imports/explorer.ts",
    "packages/core/src/imports/routes.ts",
    "packages/core/src/improve/council.ts",
    "packages/core/src/integrations/routes.ts",
    "packages/core/src/integrations/service.ts",
    "packages/core/src/launch/launcher.ts",
    "packages/core/src/launch/routes.ts",
    "packages/core/src/order/engine.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/plugins/host.ts",
    "packages/core/src/plugins/routes.ts",
    "packages/core/src/projects/budget.ts",
    "packages/core/src/projects/routes.ts",
    "packages/core/src/projects/service.ts",
    "packages/core/src/runners/manager.ts",
    "packages/core/src/runners/routes.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/setup.ts",
    "packages/core/src/signals.ts",
    "packages/core/src/store/inspect.ts",
    "packages/core/src/tickets/capture.ts",
    "packages/core/src/tickets/github.ts",
    "packages/core/src/tickets/intake.ts",
    "packages/core/src/tickets/model.ts",
    "packages/core/src/tickets/tickets.ts"
   ],
   "writes": [
    "app.update.held",
    "app.update.started",
    "app.updated",
    "bridge.seen",
    "settings.changed"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.started",
    "signal.captured"
   ],
   "serves": [
    "/api/agent",
    "/api/apps",
    "/api/bay",
    "/api/brain",
    "/api/chat",
    "/api/cost",
    "/api/events",
    "/api/factory",
    "/api/feature-map",
    "/api/health",
    "/api/imports",
    "/api/improve",
    "/api/integrations",
    "/api/launch",
    "/api/open",
    "/api/order",
    "/api/plugins",
    "/api/presence",
    "/api/projects",
    "/api/runners",
    "/api/setup",
    "/api/signals",
    "/api/since",
    "/api/store",
    "/api/tickets",
    "/api/updates"
   ],
   "sql": [
    "app_versions",
    "events",
    "factory_runs",
    "project_links",
    "projects",
    "settings"
   ]
  },
  "packages/core/src/setup.ts": {
   "lines": 143,
   "imports": [
    "packages/core/src/runtime.ts"
   ]
  },
  "packages/core/src/signals.ts": {
   "lines": 30,
   "imports": [
    "packages/core/src/events.ts"
   ],
   "writes": [
    "signal.captured"
   ],
   "sql": [
    "signals"
   ]
  },
  "packages/core/src/store/cache.ts": {
   "lines": 44
  },
  "packages/core/src/store/inspect.ts": {
   "lines": 106,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/store/cache.ts",
    "packages/core/src/store/migrations.ts"
   ],
   "sql": [
    "artifacts",
    "events",
    "factory_runs"
   ]
  },
  "packages/core/src/store/migrations.ts": {
   "lines": 127,
   "creates": [
    "events",
    "projections",
    "schema_migrations",
    "signal_fts"
   ]
  },
  "packages/core/src/store/projections.ts": {
   "lines": 49,
   "imports": [
    "packages/core/src/events.ts"
   ]
  },
  "packages/core/src/store/tables.ts": {
   "lines": 215,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.started",
    "factory.files",
    "factory.plan",
    "factory.run.finished",
    "factory.run.resumed",
    "factory.run.started",
    "order.*",
    "signal.captured"
   ],
   "creates": [
    "agent_runs",
    "artifacts",
    "factory_runs",
    "order_conflicts",
    "order_fragments",
    "order_nodes",
    "signals"
   ]
  },
  "packages/core/src/tickets/capture.ts": {
   "lines": 142,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/tickets/model.ts",
    "packages/core/src/tickets/tickets.ts"
   ],
   "writes": [
    "ticket.noted"
   ],
   "sql": [
    "tickets"
   ]
  },
  "packages/core/src/tickets/github.ts": {
   "lines": 140,
   "imports": [
    "packages/core/src/factory/workspace.ts"
   ]
  },
  "packages/core/src/tickets/intake.ts": {
   "lines": 155,
   "imports": [
    "packages/core/src/events.ts",
    "packages/core/src/order/model.ts",
    "packages/core/src/projects/service.ts",
    "packages/core/src/tickets/model.ts",
    "packages/core/src/tickets/tickets.ts"
   ],
   "writes": [
    "order.sweep"
   ],
   "sql": [
    "tickets"
   ]
  },
  "packages/core/src/tickets/model.ts": {
   "lines": 287
  },
  "packages/core/src/tickets/repowork.ts": {
   "lines": 366,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/stoprules.ts",
    "packages/core/src/factory/workbench.ts",
    "packages/core/src/factory/workspace.ts",
    "packages/core/src/imports/explorer.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/safety/gates.ts",
    "packages/core/src/safety/secrets.ts",
    "packages/core/src/safety/testguard.ts",
    "packages/core/src/tickets/github.ts"
   ],
   "writes": [
    "ticket.noted",
    "ticket.step"
   ],
   "sql": [
    "project_links"
   ]
  },
  "packages/core/src/tickets/tables.ts": {
   "lines": 174,
   "imports": [
    "packages/core/src/store/projections.ts"
   ],
   "reads": [
    "ticket.branch",
    "ticket.edited",
    "ticket.keyed",
    "ticket.line.moved",
    "ticket.linked",
    "ticket.noted",
    "ticket.opened",
    "ticket.pr",
    "ticket.run"
   ],
   "creates": [
    "ticket_keys",
    "ticket_links",
    "ticket_notes",
    "tickets"
   ]
  },
  "packages/core/src/tickets/tickets.ts": {
   "lines": 938,
   "imports": [
    "packages/core/src/agents.ts",
    "packages/core/src/bay/bay.ts",
    "packages/core/src/events.ts",
    "packages/core/src/factory/crew.ts",
    "packages/core/src/factory/loop.ts",
    "packages/core/src/projects/service.ts",
    "packages/core/src/runtime.ts",
    "packages/core/src/tickets/github.ts",
    "packages/core/src/tickets/intake.ts",
    "packages/core/src/tickets/model.ts",
    "packages/core/src/tickets/repowork.ts",
    "packages/core/src/tickets/tables.ts"
   ],
   "writes": [
    "improve.proposal.linked",
    "project.linked",
    "ticket.branch",
    "ticket.edited",
    "ticket.keyed",
    "ticket.line.moved",
    "ticket.linked",
    "ticket.noted",
    "ticket.opened",
    "ticket.pr",
    "ticket.run"
   ],
   "reads": [
    "factory.gate",
    "factory.run.finished",
    "improve.proposal.accepted",
    "order.fragment",
    "repo.suggestion",
    "ticket.*",
    "ticket.requested"
   ],
   "sql": [
    "events",
    "factory_runs",
    "project_links",
    "projects",
    "ticket_keys",
    "ticket_links",
    "ticket_notes",
    "tickets"
   ]
  },
  "apps/bridge/src/AgentBay.tsx": {
   "lines": 387,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/App.tsx": {
   "lines": 219,
   "imports": [
    "apps/bridge/src/AgentBay.tsx",
    "apps/bridge/src/Bases.tsx",
    "apps/bridge/src/Brain.tsx",
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/CodeMap.tsx",
    "apps/bridge/src/CoreDown.tsx",
    "apps/bridge/src/Cycles.tsx",
    "apps/bridge/src/DataDeck.tsx",
    "apps/bridge/src/FactoryFloor.tsx",
    "apps/bridge/src/FeatureMap.tsx",
    "apps/bridge/src/Features.tsx",
    "apps/bridge/src/ImproveDeck.tsx",
    "apps/bridge/src/Kit.tsx",
    "apps/bridge/src/OrderDeck.tsx",
    "apps/bridge/src/Overseer.tsx",
    "apps/bridge/src/Plugins.tsx",
    "apps/bridge/src/RunDeck.tsx",
    "apps/bridge/src/Runners.tsx",
    "apps/bridge/src/Setup.tsx",
    "apps/bridge/src/StarMap.tsx",
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/TicketsPanel.tsx",
    "apps/bridge/src/Timeline.tsx",
    "apps/bridge/src/Updates.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/bridge/FactoryBridge.tsx",
    "apps/bridge/src/projects/Home.tsx",
    "apps/bridge/src/projects/Workspace.tsx",
    "apps/bridge/src/projects/budgetPanel.tsx",
    "apps/bridge/src/projects/builtin.tsx",
    "apps/bridge/src/projects/improvePanel.tsx",
    "apps/bridge/src/projects/mission/Mission.tsx",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/projects/runPanel.tsx",
    "apps/bridge/src/shell/Helm.tsx",
    "apps/bridge/src/shell/NeedsYou.tsx",
    "apps/bridge/src/shell/Shortcuts.tsx",
    "apps/bridge/src/shell/Sidebar.tsx",
    "apps/bridge/src/shell/prefs.ts"
   ],
   "reads": [
    "drop.*",
    "settings.changed"
   ],
   "calls": [
    "/api/projects"
   ]
  },
  "apps/bridge/src/Bases.tsx": {
   "lines": 220,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/builtin.tsx"
   ],
   "calls": [
    "/api/bases"
   ]
  },
  "apps/bridge/src/Brain.tsx": {
   "lines": 215,
   "imports": [
    "apps/bridge/src/FeatureMap.tsx",
    "apps/bridge/src/api.ts"
   ],
   "reads": [
    "agent.run.completed",
    "bay.agent.saved",
    "bay.assign",
    "brain.*",
    "order.fragment"
   ],
   "calls": [
    "/api/brain"
   ]
  },
  "apps/bridge/src/BugReport.tsx": {
   "lines": 164,
   "imports": [
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/api.ts"
   ],
   "calls": [
    "/api/tickets"
   ]
  },
  "apps/bridge/src/CodeMap.tsx": {
   "lines": 289,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/panels.tsx",
    "apps/bridge/src/projects/router.ts"
   ],
   "reads": [
    "improve.*",
    "repo.*",
    "repo.explore.finished",
    "repo.explore.started",
    "repo.explore.station"
   ],
   "calls": [
    "/api/imports"
   ]
  },
  "apps/bridge/src/CoreDown.tsx": {
   "lines": 56,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/CrewGitHub.tsx": {
   "lines": 58,
   "imports": [
    "apps/bridge/src/api.ts"
   ],
   "calls": [
    "/api/tickets"
   ]
  },
  "apps/bridge/src/Cycles.tsx": {
   "lines": 76,
   "imports": [
    "apps/bridge/src/api.ts"
   ],
   "calls": [
    "/api/factory"
   ]
  },
  "apps/bridge/src/DataDeck.tsx": {
   "lines": 139,
   "imports": [
    "apps/bridge/src/api.ts"
   ],
   "calls": [
    "/api/store"
   ]
  },
  "apps/bridge/src/DuplicateNotice.tsx": {
   "lines": 27,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/FactoryFloor.tsx": {
   "lines": 154,
   "imports": [
    "apps/bridge/src/GateActions.tsx",
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/FeatureMap.tsx": {
   "lines": 347,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/ui/index.ts"
   ],
   "reads": [
    "featuremap.*"
   ],
   "calls": [
    "/api/feature-map"
   ]
  },
  "apps/bridge/src/Features.tsx": {
   "lines": 289,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/panels.tsx"
   ],
   "reads": [
    "factory.run.finished",
    "factory.tests",
    "integration.*",
    "repo.*"
   ],
   "calls": [
    "/api/integrations"
   ]
  },
  "apps/bridge/src/GateActions.tsx": {
   "lines": 23,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/ui/GateBar.tsx"
   ]
  },
  "apps/bridge/src/ImproveDeck.tsx": {
   "lines": 225,
   "imports": [
    "apps/bridge/src/DuplicateNotice.tsx",
    "apps/bridge/src/api.ts"
   ],
   "reads": [
    "improve.*",
    "settings.changed"
   ],
   "calls": [
    "/api/improve"
   ]
  },
  "apps/bridge/src/Intake.tsx": {
   "lines": 146,
   "imports": [
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/api.ts"
   ],
   "calls": [
    "/api/projects",
    "/api/tickets"
   ]
  },
  "apps/bridge/src/Kit.tsx": {
   "lines": 66,
   "imports": [
    "apps/bridge/src/ui/index.ts"
   ]
  },
  "apps/bridge/src/OrderDeck.tsx": {
   "lines": 270,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/Overseer.tsx": {
   "lines": 292,
   "imports": [
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/DuplicateNotice.tsx",
    "apps/bridge/src/GateActions.tsx",
    "apps/bridge/src/Intake.tsx",
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/Plugins.tsx": {
   "lines": 286,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/panels.tsx"
   ],
   "reads": [
    "plugin.*",
    "plugin.data",
    "plugin.emitted",
    "plugin.log"
   ],
   "calls": [
    "/api/plugins"
   ]
  },
  "apps/bridge/src/RunDeck.tsx": {
   "lines": 408,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/mission/Blueprint.tsx"
   ]
  },
  "apps/bridge/src/Runners.tsx": {
   "lines": 279,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/builtin.tsx"
   ],
   "calls": [
    "/api/runners"
   ]
  },
  "apps/bridge/src/Setup.tsx": {
   "lines": 132,
   "imports": [
    "apps/bridge/src/CrewGitHub.tsx",
    "apps/bridge/src/Updates.tsx",
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/StarMap.tsx": {
   "lines": 174,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/Tickets.tsx": {
   "lines": 606,
   "imports": [
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/api.ts"
   ],
   "reads": [
    "factory.gate",
    "factory.run.finished",
    "factory.run.started",
    "factory.station",
    "order.node",
    "project.*",
    "ticket.*"
   ],
   "calls": [
    "/api/projects",
    "/api/tickets"
   ]
  },
  "apps/bridge/src/TicketsPanel.tsx": {
   "lines": 24,
   "imports": [
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/projects/panels.tsx"
   ]
  },
  "apps/bridge/src/Timeline.tsx": {
   "lines": 22,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/Updates.tsx": {
   "lines": 301,
   "imports": [
    "apps/bridge/src/api.ts"
   ],
   "calls": [
    "/api/updates"
   ]
  },
  "apps/bridge/src/api.ts": {
   "lines": 613,
   "reads": [
    "agent.*",
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.started",
    "bay.*",
    "factory.attempt",
    "factory.council",
    "factory.discovery",
    "factory.evaluation",
    "factory.fastgate",
    "factory.feature",
    "factory.files",
    "factory.gate",
    "factory.ladder",
    "factory.plan",
    "factory.plan.gaps",
    "factory.retro",
    "factory.review",
    "factory.run.*",
    "factory.run.finished",
    "factory.run.resumed",
    "factory.run.started",
    "factory.station",
    "factory.tests",
    "factory.tests.disputed",
    "factory.tests.locked",
    "factory.visual",
    "integration.*",
    "launch.exited",
    "launch.started",
    "order.*",
    "project.*",
    "settings.changed",
    "signal.captured"
   ],
   "calls": [
    "/api/agent",
    "/api/bay",
    "/api/chat",
    "/api/events",
    "/api/factory",
    "/api/health",
    "/api/launch",
    "/api/open",
    "/api/order",
    "/api/presence",
    "/api/projects",
    "/api/setup",
    "/api/signals",
    "/api/since"
   ]
  },
  "apps/bridge/src/bridge/FactoryBridge.tsx": {
   "lines": 58,
   "imports": [
    "apps/bridge/src/FactoryFloor.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/bridge/LanternQuarter.tsx",
    "apps/bridge/src/bridge/Partitura.tsx",
    "apps/bridge/src/bridge/SignalLoom.tsx",
    "apps/bridge/src/projects/router.ts"
   ]
  },
  "apps/bridge/src/bridge/LanternQuarter.tsx": {
   "lines": 94,
   "imports": [
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/bridge/SignalLoom.tsx",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/projects/shortName.ts"
   ],
   "reads": [
    "ticket.*"
   ]
  },
  "apps/bridge/src/bridge/Partitura.tsx": {
   "lines": 166,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/bridge/SignalLoom.tsx"
   ]
  },
  "apps/bridge/src/bridge/SignalLoom.tsx": {
   "lines": 174,
   "imports": [
    "apps/bridge/src/FactoryFloor.tsx",
    "apps/bridge/src/GateActions.tsx",
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/main.tsx": {
   "lines": 23,
   "imports": [
    "apps/bridge/src/App.tsx",
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/styles.css"
   ]
  },
  "apps/bridge/src/projects/Home.tsx": {
   "lines": 183,
   "imports": [
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/CodeMap.tsx",
    "apps/bridge/src/Intake.tsx",
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/builtin.tsx",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/projects/shortName.ts",
    "apps/bridge/src/ui/index.ts"
   ]
  },
  "apps/bridge/src/projects/Workspace.tsx": {
   "lines": 85,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/builtin.tsx",
    "apps/bridge/src/projects/panels.tsx",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/projects/shortName.ts"
   ]
  },
  "apps/bridge/src/projects/addScreen.tsx": {
   "lines": 54,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/panels.tsx"
   ],
   "calls": [
    "/api/projects"
   ]
  },
  "apps/bridge/src/projects/budgetPanel.tsx": {
   "lines": 80,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/panels.tsx",
    "apps/bridge/src/ui/index.ts"
   ],
   "calls": [
    "/api/projects"
   ]
  },
  "apps/bridge/src/projects/builtin.tsx": {
   "lines": 243,
   "imports": [
    "apps/bridge/src/Intake.tsx",
    "apps/bridge/src/OrderDeck.tsx",
    "apps/bridge/src/RunDeck.tsx",
    "apps/bridge/src/StarMap.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/panels.tsx",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/ui/index.ts"
   ],
   "reads": [
    "factory.*",
    "factory.gate",
    "factory.run.finished",
    "factory.run.started",
    "order.conflict",
    "order.fragment",
    "order.node",
    "project.created",
    "project.linked",
    "project.unlinked",
    "project.updated"
   ]
  },
  "apps/bridge/src/projects/dataFiles.tsx": {
   "lines": 285,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/projects/improvePanel.tsx": {
   "lines": 21,
   "imports": [
    "apps/bridge/src/ImproveDeck.tsx",
    "apps/bridge/src/projects/panels.tsx"
   ]
  },
  "apps/bridge/src/projects/mission/Blueprint.tsx": {
   "lines": 230,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/mission/blueprint.css",
    "apps/bridge/src/projects/mission/model.ts"
   ]
  },
  "apps/bridge/src/projects/mission/Mission.tsx": {
   "lines": 208,
   "imports": [
    "apps/bridge/src/DuplicateNotice.tsx",
    "apps/bridge/src/GateActions.tsx",
    "apps/bridge/src/Intake.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/builtin.tsx",
    "apps/bridge/src/projects/mission/MissionTrack.tsx",
    "apps/bridge/src/projects/mission/RepoWork.tsx",
    "apps/bridge/src/projects/mission/mission.css",
    "apps/bridge/src/projects/mission/model.ts",
    "apps/bridge/src/projects/mission/stages.tsx",
    "apps/bridge/src/projects/panels.tsx"
   ],
   "reads": [
    "factory.discovery",
    "factory.evaluation",
    "factory.feature",
    "factory.plan",
    "factory.run.finished"
   ]
  },
  "apps/bridge/src/projects/mission/MissionTrack.tsx": {
   "lines": 109,
   "imports": [
    "apps/bridge/src/projects/mission/model.ts"
   ]
  },
  "apps/bridge/src/projects/mission/RepoWork.tsx": {
   "lines": 71,
   "imports": [
    "apps/bridge/src/BugReport.tsx",
    "apps/bridge/src/Intake.tsx",
    "apps/bridge/src/Tickets.tsx",
    "apps/bridge/src/projects/panels.tsx"
   ],
   "reads": [
    "ticket.*"
   ]
  },
  "apps/bridge/src/projects/mission/blueprint.css": {
   "lines": 138
  },
  "apps/bridge/src/projects/mission/mission.css": {
   "lines": 232
  },
  "apps/bridge/src/projects/mission/model.ts": {
   "lines": 162,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/projects/mission/stages.tsx": {
   "lines": 267,
   "imports": [
    "apps/bridge/src/GateActions.tsx",
    "apps/bridge/src/RunDeck.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/mission/Blueprint.tsx",
    "apps/bridge/src/projects/mission/model.ts"
   ]
  },
  "apps/bridge/src/projects/panels.tsx": {
   "lines": 90,
   "imports": [
    "apps/bridge/src/api.ts"
   ],
   "reads": [
    "agent.run.*",
    "factory.*",
    "factory.run.started",
    "order.conflict",
    "order.fragment",
    "order.node",
    "project.*"
   ]
  },
  "apps/bridge/src/projects/router.ts": {
   "lines": 88
  },
  "apps/bridge/src/projects/runPanel.tsx": {
   "lines": 358,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/addScreen.tsx",
    "apps/bridge/src/projects/builtin.tsx",
    "apps/bridge/src/projects/dataFiles.tsx",
    "apps/bridge/src/projects/panels.tsx",
    "apps/bridge/src/projects/useTool.tsx"
   ],
   "reads": [
    "launch.*",
    "project.linked"
   ],
   "calls": [
    "/api/launch"
   ]
  },
  "apps/bridge/src/projects/shortName.ts": {
   "lines": 15
  },
  "apps/bridge/src/projects/useTool.tsx": {
   "lines": 186,
   "imports": [
    "apps/bridge/src/api.ts"
   ]
  },
  "apps/bridge/src/shell/ApprovalCard.tsx": {
   "lines": 69,
   "imports": [
    "apps/bridge/src/GateActions.tsx",
    "apps/bridge/src/api.ts",
    "apps/bridge/src/ui/index.ts"
   ]
  },
  "apps/bridge/src/shell/Helm.tsx": {
   "lines": 114,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/projects/shortName.ts"
   ]
  },
  "apps/bridge/src/shell/NeedsYou.tsx": {
   "lines": 49,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/shell/ApprovalCard.tsx",
    "apps/bridge/src/ui/index.ts"
   ]
  },
  "apps/bridge/src/shell/Shortcuts.tsx": {
   "lines": 61,
   "imports": [
    "apps/bridge/src/projects/router.ts"
   ]
  },
  "apps/bridge/src/shell/Sidebar.tsx": {
   "lines": 77,
   "imports": [
    "apps/bridge/src/api.ts",
    "apps/bridge/src/projects/Home.tsx",
    "apps/bridge/src/projects/router.ts",
    "apps/bridge/src/projects/shortName.ts",
    "apps/bridge/src/ui/index.ts"
   ]
  },
  "apps/bridge/src/shell/prefs.ts": {
   "lines": 24
  },
  "apps/bridge/src/styles.css": {
   "lines": 1985
  },
  "apps/bridge/src/ui/EmptyState.tsx": {
   "lines": 20
  },
  "apps/bridge/src/ui/GateBar.tsx": {
   "lines": 66
  },
  "apps/bridge/src/ui/StatusGlyph.tsx": {
   "lines": 29
  },
  "apps/bridge/src/ui/index.ts": {
   "lines": 4,
   "imports": [
    "apps/bridge/src/ui/EmptyState.tsx",
    "apps/bridge/src/ui/GateBar.tsx",
    "apps/bridge/src/ui/StatusGlyph.tsx"
   ]
  },
  "src-tauri/src/main.rs": {
   "lines": 298
  },
  "src-tauri/src/updates.rs": {
   "lines": 245
  }
 }
};
