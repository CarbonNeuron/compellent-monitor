# Compellent monitor

A read-only SNMP dashboard for Dell Compellent Storage Center arrays. A single Go
binary serves the embedded web UI on port **3000**, polls SNMP v2c every 30 seconds,
and runs in a small, non-root container.

## Dashboard

- Array overview with Dell's global rollup and independently reported faults.
- Disk bay maps, disk health, model/serial inventory, disk folders, and capacity.
- Controllers, enclosures, fans, temperatures, voltage sensors, power supplies,
  I/O modules, audible alarms, UPS entries, and cache battery states.
- Volume health, server connectivity and primary paths, replays and object counts.
- Active and historical alert entries with decoded severity, category, activity,
  acknowledgment, and controller source.
- Management-interface receive/transmit rates, capacity and peak temperature trends.
- Searchable MIB explorer, full object details, JSON export, and Prometheus metrics.

The bundled `mibs/DELL-STORAGE-SC-MIB.mib` is Dell's supplied 2014 MIB (copyright
Dell Inc.; original notice retained). `scripts/generate_schema.py` compiles numeric
OIDs, enums, compound indexes, descriptions, and units into `mibs/schema.json`.
Runtime polling does not need Net-SNMP, Python, or access to the source MIB.

## Run

```sh
cp .env.example .env
# Set SNMP_TARGET and SNMP_COMMUNITY in .env.
docker compose up --build -d
```

Open <http://localhost:3000>. The community is required, has no default, and is
excluded from application source, Docker build context, logs, API responses, and
exports. `.env` is ignored by Git. For a local Go run:

```sh
set -a
. ./.env
set +a
go run .
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SNMP_TARGET` | required | IP address or DNS name of the array |
| `SNMP_COMMUNITY` | required | SNMP v2c community |
| `SNMP_PORT` | `161` | Agent UDP port |
| `SNMP_TIMEOUT` | `2s` | Timeout per request |
| `SNMP_RETRIES` | `1` | Retries per request |
| `SNMP_MAX_REPETITIONS` | `25` | GETBULK batch size; reduced automatically on TooBig |
| `POLL_INTERVAL` | `30s` | Poll interval; minimum 5s |
| `POLL_TIMEOUT` | `25s` | Deadline for a complete collection cycle |
| `HISTORY_LIMIT` | `720` | Bounded in-memory history; about 6h at 30s |
| `PORT` | `3000` | HTTP port |

Polls never overlap. Failed walks preserve the previous complete data for that
source. The UI shows failures and stale timestamps; interface rates reset after
failed samples, counter discontinuities, or agent restarts. History resets when
the monitor restarts. This application sends **GETBULK only**; there are no SET
operations, trap triggers, or alert acknowledgment controls.

## Interpreting the data

The live SC7020 discovery returned 4,096 Dell objects plus 118 standard system and
interface objects: 132 disks, two controllers, three enclosures, 40 volume entries,
11 managed server entries, and environmental and alert tables. Counts can change
with array configuration. Empty tables are shown as not reported, including UPS
and audible alarms on the initial target.

- This MIB does **not** expose SAN IOPS, SAN throughput, latency, or per-volume
  capacity. Performance charts explicitly show agent management-interface traffic.
- Modern disk-folder fields are GiB, despite the MIB calling them GB. Deprecated
  decimal GB fields are converted when modern fields are absent. Raw disk size
  retains the GB unit declared by the MIB.
- Used space is a subset of allocated volume space on the observed firmware.
  Free, allocated, used, and spare values are displayed as reported, without
  enforcing the formula in the older MIB description.
- Global status can be OK while individual volume or active-alert entries report
  faults. The dashboard shows the global value and derives its health summary
  from current component states and active alerts. Historical trap-context scalars
  and cleared alerts do not change that health summary.
- Alert indexes include controller and alert number. A shared condition can be
  reported twice. Counts deliberately refer to **entries**, not unique incidents.
- Table volume/server counts can differ from the object-count summary. Both are
  available; entries are not silently deduplicated.
- Battery expiration timestamps and current battery status are displayed separately.
  The app does not invent an expired state from an old timestamp.

## API and health checks

| Path | Response |
| --- | --- |
| `/api/snapshot` | Latest summary, tables, source state, interface rates, and history |
| `/api/objects` | Every collected OID, decoded value, and instance index |
| `/api/schema` | MIB field and table definitions |
| `/api/export` | Downloadable JSON snapshot including all objects |
| `/metrics` | SNMP availability, last success, disks, alert entries, capacity, temperature |
| `/healthz`, `/readyz` | Web-service health, independent of SAN availability |

The web UI refreshes cached data every five seconds; requests do not trigger walks.
Readiness stays healthy during target outages so the dashboard remains reachable.
The `compellent_snmp_up` metric reports successful, fresh SNMP collection separately.

## Tests

Requires Go 1.26, Node.js 22+, and Python 3 for regenerating the MIB schema.

```sh
go test -race -cover ./...
go vet ./...
python3 scripts/generate_schema.py
git diff --exit-code -- mibs/schema.json
npm ci
npx playwright install chromium
npm test
docker build -t compellent-monitor:local .
```

Browser tests use synthetic data and a local test service, never production SNMP.
They cover all views under the real Content Security Policy, disk details, search,
HTML escaping, alert filters, failure/initial states, and mobile layout.

## GitHub Actions and Flux

The workflow tests the Go and browser code, then builds amd64 and arm64 images on
pushes to `main` and `v*` tags. It publishes
`ghcr.io/carbonneuron/compellent-monitor:latest`, plus branch/tag and commit tags.
Pull requests run checks and build without publishing.

Flux manifests live in `hiv3-cluster/clusters/hiv3/apps/compellent-monitor/`, included
by the apps parent kustomization. They use a dedicated namespace, resource limits,
health probes, a read-only root filesystem, and a Traefik HTTPS Gateway API route
for **compellent.hiv3.net**. The route follows the cluster's existing Authentik
forward-auth component. Configuration comes from environment variables in the
deployment; the community is injected there, outside this application repository.

The GHCR package must be public for this cluster to pull it without secrets.
Verify with an anonymous registry manifest request or a pull from a Docker client
without stored registry credentials. `imagePullPolicy: Always` handles the mutable
`latest` tag when a Pod starts. After future releases, update the deployment's
release annotation in Git to make Flux start new Pods for the new image.
