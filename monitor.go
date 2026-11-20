package main

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gosnmp/gosnmp"
)

type Row struct {
	Index  string           `json:"index"`
	Values map[string]Value `json:"values"`
}

func (r Row) num(name string) float64 { return number(r.Values[name].Value) }
func (r Row) text(name string) string {
	v := r.Values[name]
	if v.Label != "" {
		return v.Label
	}
	if v.Value == nil {
		return ""
	}
	return fmt.Sprint(v.Value)
}

type Summary struct {
	Status       string   `json:"status"`
	GlobalStatus string   `json:"globalStatus"`
	Disks        int      `json:"disks"`
	HealthyDisks int      `json:"healthyDisks"`
	Volumes      int      `json:"volumes"`
	Servers      int      `json:"servers"`
	Controllers  int      `json:"controllers"`
	Enclosures   int      `json:"enclosures"`
	ActiveAlerts int      `json:"activeAlerts"`
	TotalGiB     float64  `json:"totalGiB"`
	UsedGiB      float64  `json:"usedGiB"`
	AllocatedGiB float64  `json:"allocatedGiB"`
	FreeGiB      float64  `json:"freeGiB"`
	SpareGiB     float64  `json:"spareGiB"`
	MaxTempC     *float64 `json:"maxTempC"`
	Issues       []Issue  `json:"issues"`
}
type Issue struct {
	Table    string `json:"table"`
	Index    string `json:"index"`
	Name     string `json:"name"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}
type Interface struct {
	Index    string   `json:"index"`
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	Speed    float64  `json:"speed"`
	RX       *float64 `json:"rxBytesPerSec"`
	TX       *float64 `json:"txBytesPerSec"`
	Errors   float64  `json:"errors"`
	Discards float64  `json:"discards"`
}
type Point struct {
	Time     time.Time `json:"time"`
	UsedGiB  float64   `json:"usedGiB"`
	MaxTempC *float64  `json:"maxTempC"`
	RX       *float64  `json:"rxBytesPerSec"`
	TX       *float64  `json:"txBytesPerSec"`
}
type Snapshot struct {
	Target              string           `json:"target"`
	PollIntervalSeconds float64          `json:"pollIntervalSeconds"`
	State               string           `json:"state"`
	LastAttempt         time.Time        `json:"lastAttempt"`
	LastSuccess         time.Time        `json:"lastSuccess"`
	Error               string           `json:"error,omitempty"`
	Sources             []Source         `json:"sources"`
	Scalars             map[string]Value `json:"scalars"`
	Tables              map[string][]Row `json:"tables"`
	Summary             Summary          `json:"summary"`
	Interfaces          []Interface      `json:"interfaces"`
	History             []Point          `json:"history"`
	ObjectCount         int              `json:"objectCount"`
	Objects             []Observation    `json:"-"`
}
type counterSample struct {
	At           time.Time
	Uptime       float64
	Rows         map[string]Row
	ExtendedGood bool
}
type Monitor struct {
	cfg      Config
	schema   *Schema
	walker   walkSource
	current  atomic.Pointer[Snapshot]
	cache    map[string][]gosnmp.SnmpPDU
	sources  []Source
	previous *counterSample
}

func newMonitor(c Config, s *Schema, walker walkSource) *Monitor {
	m := &Monitor{cfg: c, schema: s, walker: walker, cache: make(map[string][]gosnmp.SnmpPDU), sources: append([]Source(nil), sourceDefs...)}
	m.current.Store(&Snapshot{Target: c.Target, PollIntervalSeconds: c.PollInterval.Seconds(), State: "starting", Sources: append([]Source(nil), m.sources...), Scalars: map[string]Value{}, Tables: map[string][]Row{}, History: []Point{}, Interfaces: []Interface{}, Objects: []Observation{}, Summary: Summary{Status: "unknown", Issues: []Issue{}}})
	return m
}

func (m *Monitor) run(ctx context.Context) {
	m.poll(ctx)
	ticker := time.NewTicker(m.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.poll(ctx)
		}
	}
}

func (m *Monitor) poll(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, m.cfg.PollTimeout)
	defer cancel()
	now := time.Now().UTC()
	old := m.current.Load()
	for i, src := range m.sources {
		start := time.Now()
		pdus, err := m.walker(ctx, src)
		if err == nil && i == 0 && len(pdus) == 0 {
			err = fmt.Errorf("no Dell objects returned; check the SNMP view and target")
		}
		m.sources[i].DurationMS = time.Since(start).Milliseconds()
		m.sources[i].Error = ""
		if err != nil {
			// Community values are never included in logs or HTTP error responses.
			m.sources[i].Error = strings.ReplaceAll(err.Error(), m.cfg.Community, "[redacted]")
		} else {
			m.cache[src.Root] = pdus
			m.sources[i].Count = len(pdus)
			m.sources[i].UpdatedAt = time.Now().UTC()
		}
	}
	s := m.build()
	s.LastAttempt = now
	s.LastSuccess = old.LastSuccess
	s.History = append([]Point{}, old.History...)
	s.Sources = append([]Source(nil), m.sources...)
	if m.sources[0].Error != "" {
		s.State = "error"
		s.Error = m.sources[0].Error
		// No rates survive a failed or stale sample, and do not connect chart gaps.
		m.previous = nil
		slog.Warn("SNMP poll failed", "target", m.cfg.Target, "error", s.Error)
	} else {
		s.State = "ok"
		s.LastSuccess = m.sources[0].UpdatedAt
		networkOK := m.sources[1].Error == "" && m.sources[2].Error == ""
		s.Interfaces = m.interfaces(s, m.sources[2].UpdatedAt, networkOK)
		p := Point{Time: s.LastSuccess, UsedGiB: s.Summary.UsedGiB, MaxTempC: s.Summary.MaxTempC}
		for _, iface := range s.Interfaces {
			// Loopback is never part of total management network traffic.
			if strings.HasPrefix(iface.Name, "lo") {
				continue
			}
			if iface.RX != nil {
				if p.RX == nil {
					p.RX = new(float64)
				}
				*p.RX += *iface.RX
			}
			if iface.TX != nil {
				if p.TX == nil {
					p.TX = new(float64)
				}
				*p.TX += *iface.TX
			}
		}
		s.History = append(s.History, p)
		if len(s.History) > m.cfg.HistoryLimit {
			s.History = append([]Point{}, s.History[len(s.History)-m.cfg.HistoryLimit:]...)
		}
		slog.Info("SNMP poll complete", "target", m.cfg.Target, "objects", s.ObjectCount, "duration", time.Since(now).Round(time.Millisecond))
	}
	if s.State == "error" {
		s.Interfaces = m.interfaces(s, now, false)
	}
	m.current.Store(s)
}

func (m *Monitor) build() *Snapshot {
	s := &Snapshot{Target: m.cfg.Target, PollIntervalSeconds: m.cfg.PollInterval.Seconds(), Scalars: map[string]Value{}, Tables: map[string][]Row{}, Objects: []Observation{}, Interfaces: []Interface{}}
	rows := map[string]map[string]*Row{}
	for _, def := range m.schema.Tables {
		rows[def.Name] = map[string]*Row{}
	}
	for _, src := range sourceDefs {
		for _, pdu := range m.cache[src.Root] {
			o := m.schema.decode(pdu)
			s.Objects = append(s.Objects, o)
			if o.Table == "" {
				s.Scalars[o.Name] = o.Value
				continue
			}
			if rows[o.Table][o.Index] == nil {
				rows[o.Table][o.Index] = &Row{Index: o.Index, Values: map[string]Value{}}
			}
			rows[o.Table][o.Index].Values[o.Name] = o.Value
		}
	}
	for table, entries := range rows {
		s.Tables[table] = []Row{}
		for _, row := range entries {
			s.Tables[table] = append(s.Tables[table], *row)
		}
		sort.Slice(s.Tables[table], func(i, j int) bool { return compareOID(s.Tables[table][i].Index, s.Tables[table][j].Index) < 0 })
	}
	sort.Slice(s.Objects, func(i, j int) bool { return compareOID(s.Objects[i].OID, s.Objects[j].OID) < 0 })
	s.ObjectCount = len(s.Objects)
	s.Summary = summarize(s)
	return s
}

func summarize(s *Snapshot) Summary {
	result := Summary{Status: "unknown", GlobalStatus: s.Scalars["productIDGlobalStatus"].Label, Disks: len(s.Tables["scDiskTable"]), Volumes: len(s.Tables["scVolumeTable"]), Servers: len(s.Tables["scServerTable"]), Controllers: len(s.Tables["scCtlrTable"]), Enclosures: len(s.Tables["scEnclTable"]), Issues: []Issue{}}
	result.Status = severity(result.GlobalStatus)
	for _, row := range s.Tables["scDiskTable"] {
		if row.text("scDiskStatus") == "up" && row.text("scDiskHealthy") == "true" {
			result.HealthyDisks++
		}
	}
	for _, row := range s.Tables["scDiskFolderSUTable"] {
		// Modern fields use binary GiB, deprecated fields use decimal GB.
		total, ok := row.Values["scDiskFolderSUTotalSpace2"]
		if !ok {
			total.Value = row.num("scDiskFolderSUTotalSpace") * 1e9 / (1 << 30)
		}
		used, ok := row.Values["scDiskFolderSUUsedSpace2"]
		if !ok {
			used.Value = row.num("scDiskFolderSUUsedSpace") * 1e9 / (1 << 30)
		}
		result.TotalGiB += number(total.Value)
		result.UsedGiB += number(used.Value)
		result.AllocatedGiB += row.num("scDiskFolderSUAllocSpace")
		result.FreeGiB += row.num("scDiskFolderSUFreeSpace")
		result.SpareGiB += row.num("scDiskFolderSUSpareSpace")
	}
	add := func(table string, row Row, field string, level string) {
		name := row.Index
		for _, key := range []string{"scDiskNamePosition", "scCtlrName", "scEnclName", "scVolumeName", "scServerName", "scCacheName", "scDiskFolderName"} {
			if n := row.text(key); n != "" {
				name = n
				break
			}
		}
		message := field + ": " + row.text(field)
		if table == "scAlertTable" {
			name = "Controller " + strings.Split(row.Index, ".")[0] + " · alert " + strings.Join(strings.Split(row.Index, ".")[1:], ".")
			if row.text("scAlertMessage") != "" {
				message = row.text("scAlertMessage")
			}
		}
		result.Issues = append(result.Issues, Issue{Table: table, Index: row.Index, Name: name, Severity: level, Message: message})
		if level == "critical" || result.Status != "critical" {
			result.Status = level
		}
	}
	for table, entries := range s.Tables {
		if table == "ifTable" || table == "scAlertTable" {
			continue
		}
		for _, row := range entries {
			for name, value := range row.Values {
				if strings.HasSuffix(name, "Status") || name == "scServerCnctvy" || name == "scCacheBatStat" {
					level := severity(value.Label)
					if level == "warning" || level == "critical" {
						add(table, row, name, level)
					}
				}
			}
			if table == "scDiskTable" && row.text("scDiskHealthy") == "false" {
				add(table, row, "scDiskHealthy", "critical")
			}
			for _, field := range []string{"scCtlrTempCurrentC", "scEnclTempCurrentC"} {
				if v, ok := row.Values[field]; ok {
					n := number(v.Value)
					if result.MaxTempC == nil || n > *result.MaxTempC {
						result.MaxTempC = &n
					}
				}
			}
		}
	}
	for _, row := range s.Tables["scAlertTable"] {
		if row.text("scAlertActive") != "true" {
			continue
		}
		result.ActiveAlerts++
		level := severity(row.text("scAlertStatus"))
		if level == "warning" || level == "critical" {
			add("scAlertTable", row, "scAlertStatus", level)
		}
	}
	sort.Slice(result.Issues, func(i, j int) bool {
		a, b := result.Issues[i], result.Issues[j]
		if a.Severity != b.Severity {
			return a.Severity == "critical"
		}
		return a.Table+a.Index+a.Message < b.Table+b.Index+b.Message
	})
	return result
}

func counterRate(current, previous Value, seconds, speed float64) *float64 {
	if current.Value == nil || previous.Value == nil || seconds <= 0 {
		return nil
	}
	currentCount, currentErr := strconv.ParseUint(fmt.Sprint(current.Value), 10, 64)
	previousCount, previousErr := strconv.ParseUint(fmt.Sprint(previous.Value), 10, 64)
	if currentErr != nil || previousErr != nil {
		return nil
	}
	var delta uint64
	if currentCount < previousCount {
		// Only infer a 32-bit wrap when both ends sit near the wrap boundary.
		if _, is64 := current.Value.(string); is64 || number(previous.Value) < 0.9*(1<<32) || number(current.Value) > 0.1*(1<<32) {
			return nil
		}
		delta = (1 << 32) - previousCount + currentCount
	} else {
		delta = currentCount - previousCount
	}
	rate := float64(delta) / seconds
	if speed > 0 && rate*8 > speed*1.05 {
		return nil
	}
	return &rate
}

func (m *Monitor) interfaces(s *Snapshot, at time.Time, good bool) []Interface {
	result := []Interface{}
	rows := map[string]Row{}
	uptime := number(s.Scalars["sysUpTime"].Value)
	for _, row := range s.Tables["ifTable"] {
		rows[row.Index] = row
		name := row.text("ifName")
		if name == "" {
			name = row.text("ifDescr")
		}
		speed := row.num("ifSpeed")
		if row.num("ifHighSpeed") > 0 {
			speed = row.num("ifHighSpeed") * 1e6
		}
		iface := Interface{Index: row.Index, Name: name, Status: row.text("ifOperStatus"), Speed: speed, Errors: row.num("ifInErrors") + row.num("ifOutErrors"), Discards: row.num("ifInDiscards") + row.num("ifOutDiscards")}
		if good && m.previous != nil && uptime >= m.previous.Uptime && at.Sub(m.previous.At) <= 3*m.cfg.PollInterval+m.cfg.PollTimeout {
			prev, ok := m.previous.Rows[row.Index]
			if ok && prev.text("ifDescr") == row.text("ifDescr") && prev.text("ifCounterDiscontinuityTime") == row.text("ifCounterDiscontinuityTime") {
				rx, tx := "ifInOctets", "ifOutOctets"
				// A failed extended walk retains data for inspection, never for rates.
				if m.sources[3].Error == "" && m.previous.ExtendedGood && row.Values["ifHCInOctets"].Value != nil {
					rx = "ifHCInOctets"
				}
				if m.sources[3].Error == "" && m.previous.ExtendedGood && row.Values["ifHCOutOctets"].Value != nil {
					tx = "ifHCOutOctets"
				}
				seconds := at.Sub(m.previous.At).Seconds()
				iface.RX = counterRate(row.Values[rx], prev.Values[rx], seconds, speed)
				iface.TX = counterRate(row.Values[tx], prev.Values[tx], seconds, speed)
			}
		}
		result = append(result, iface)
	}
	if good {
		m.previous = &counterSample{At: at, Uptime: uptime, Rows: rows, ExtendedGood: m.sources[3].Error == ""}
	} else {
		m.previous = nil
	}
	return result
}
