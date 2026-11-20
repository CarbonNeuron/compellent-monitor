package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

func testSchema(t *testing.T) *Schema {
	t.Helper()
	s, err := loadSchema()
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func pdu(s *Schema, name, index string, value any) gosnmp.SnmpPDU {
	for _, f := range s.Fields {
		if f.Name == name {
			kind := gosnmp.Integer
			if _, ok := value.([]byte); ok {
				kind = gosnmp.OctetString
			}
			return gosnmp.SnmpPDU{Name: f.OID + "." + index, Type: kind, Value: value}
		}
	}
	panic(name)
}
func testConfig() Config {
	return Config{Target: "127.0.0.1", Community: "test-community", PollInterval: 30 * time.Second, PollTimeout: time.Second, HistoryLimit: 2, MaxRepetitions: 25}
}
func fixture(s *Schema) []gosnmp.SnmpPDU {
	return []gosnmp.SnmpPDU{
		pdu(s, "productIDGlobalStatus", "0", 3), pdu(s, "scDiskNbr", "12", 12), pdu(s, "scDiskStatus", "12", 1), pdu(s, "scDiskHealthy", "12", 1), pdu(s, "scDiskNamePosition", "12", []byte("01-12")),
		pdu(s, "scCtlrTempCurrentC", "1.12", 31), pdu(s, "scCtlrTempStatus", "1.12", 1), pdu(s, "scCtlrTempCurrentC", "2.1", 34),
		pdu(s, "scDiskFolderSUTotalSpace2", "2", 1000), pdu(s, "scDiskFolderSUUsedSpace2", "2", 200), pdu(s, "scDiskFolderSUAllocSpace", "2", 400), pdu(s, "scDiskFolderSUFreeSpace", "2", 500), pdu(s, "scDiskFolderSUSpareSpace", "2", 100),
		pdu(s, "scAlertStatus", "1.1", 1), pdu(s, "scAlertActive", "1.1", 2), pdu(s, "scAlertStatus", "2.1", 2), pdu(s, "scAlertActive", "2.1", 1),
		// Trap context is historical and must never affect the current rollup.
		pdu(s, "scHWCompStatus", "0", 2), pdu(s, "scSIDeviceStatus", "0", 2),
	}
}

func TestSchemaDecodesCompoundIndexesAndDistinctEnums(t *testing.T) {
	s := testSchema(t)
	for _, tt := range []struct {
		name, index string
		n           int
		want        string
	}{
		{"scCtlrTempStatus", "1.12", 1, "up"}, {"scAlertStatus", "2.12", 1, "critical"}, {"scAlertActive", "2.12", 2, "false"}, {"productIDGlobalStatus", "0", 3, "ok"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			o := s.decode(pdu(s, tt.name, tt.index, tt.n))
			if o.Index != tt.index || o.Label != tt.want {
				t.Fatalf("%+v", o)
			}
		})
	}
	for _, f := range s.Fields {
		if f.Access == "not-accessible" {
			t.Fatal("inaccessible fields included")
		}
	}
	if len(s.Tables) != 23 {
		t.Fatalf("tables=%d", len(s.Tables))
	}
}

func TestOctetStringsAndDateFormats(t *testing.T) {
	s := testSchema(t)
	for _, tt := range []struct {
		data []byte
		want string
	}{
		{[]byte("2023-04-17T00:00:00-05:00"), "2023-04-17T00:00:00-05:00"},
		{[]byte{7, 234, 11, 20, 10, 11, 12, 3, '-', 6, 0}, "2026-11-20T10:11:12.3-06:00"},
		{[]byte{0, 0}, "0x0000"},
	} {
		if got := s.decode(pdu(s, "scCacheBatExpr", "1", tt.data)).Value.Value; got != tt.want {
			t.Fatalf("got %v want %v", got, tt.want)
		}
	}
	p := pdu(s, "ifHCInOctets", "1", uint64(math.MaxUint64))
	p.Type = gosnmp.Counter64
	if got := s.decode(p).Value.Value; got != "18446744073709551615" {
		t.Fatalf("counter precision lost: %v", got)
	}
}

func TestSummaryUsesCurrentStatesAndReportedCapacity(t *testing.T) {
	s := testSchema(t)
	m := newMonitor(testConfig(), s, nil)
	m.cache[sourceDefs[0].Root] = fixture(s)
	result := m.build()
	if result.Summary.Status != "warning" || result.Summary.ActiveAlerts != 1 || result.Summary.HealthyDisks != 1 {
		t.Fatalf("%+v", result.Summary)
	}
	if len(result.Tables["scCtlrTempTable"]) != 2 || len(result.Tables["scAlertTable"]) != 2 {
		t.Fatal("compound indices were merged")
	}
	if *result.Summary.MaxTempC != 34 || result.Summary.TotalGiB != 1000 || result.Summary.UsedGiB != 200 || result.Summary.FreeGiB != 500 {
		t.Fatalf("%+v", result.Summary)
	}
	for _, issue := range result.Summary.Issues {
		if issue.Table != "scAlertTable" {
			t.Fatalf("historical trap became current fault: %+v", issue)
		}
	}
}

func TestDeprecatedCapacityConvertsDecimalGB(t *testing.T) {
	s := testSchema(t)
	m := newMonitor(testConfig(), s, nil)
	m.cache[sourceDefs[0].Root] = []gosnmp.SnmpPDU{pdu(s, "scDiskFolderSUTotalSpace", "2", 1074), pdu(s, "scDiskFolderSUUsedSpace", "2", 10)}
	got := m.build().Summary.TotalGiB
	if math.Abs(got-1074*1e9/(1<<30)) > .00001 {
		t.Fatalf("total %v", got)
	}
}

func TestPollFailurePreservesLastCompleteDataAndRedacts(t *testing.T) {
	s := testSchema(t)
	fail := false
	m := newMonitor(testConfig(), s, func(ctx context.Context, src Source) ([]gosnmp.SnmpPDU, error) {
		if src.Root == sourceDefs[0].Root {
			if fail {
				return fixture(s)[:1], errors.New("secret test-community timeout")
			}
			return fixture(s), nil
		}
		return nil, nil
	})
	m.poll(context.Background())
	before := m.current.Load()
	fail = true
	m.poll(context.Background())
	after := m.current.Load()
	if after.State != "error" || after.LastSuccess != before.LastSuccess || after.ObjectCount != before.ObjectCount || len(after.History) != 1 {
		t.Fatalf("%+v", after)
	}
	if strings.Contains(after.Error, "test-community") {
		t.Fatal("community leaked")
	}
	if before.State != "ok" || before.Sources[0].Error != "" {
		t.Fatal("previous snapshot mutated")
	}
	fail = false
	for range 3 {
		m.poll(context.Background())
	}
	if len(m.current.Load().History) != 2 {
		t.Fatal("history not bounded")
	}
}

func TestEmptyDellWalkIsFailure(t *testing.T) {
	m := newMonitor(testConfig(), testSchema(t), func(context.Context, Source) ([]gosnmp.SnmpPDU, error) { return nil, nil })
	m.poll(context.Background())
	if m.current.Load().State != "error" || !m.current.Load().LastSuccess.IsZero() {
		t.Fatal("empty agent marked healthy")
	}
}

func TestCounterRates(t *testing.T) {
	for _, tt := range []struct {
		name      string
		now, prev any
		dt, speed float64
		want      *float64
	}{
		{"normal", uint32(150), uint32(50), 10, 1000, ptr(10)},
		{"reset", uint32(10), uint32(50), 10, 1000, nil},
		{"wrap", uint32(10), uint32(math.MaxUint32 - 9), 2, 1000, ptr(10)},
		{"64-bit", "1000", "500", 10, 1000, ptr(50)},
		{"64-bit-small-delta", "18446744073709551615", "18446744073709551605", 1, 1000, ptr(10)},
		{"64-reset", "10", "500", 10, 1000, nil},
		{"impossible-speed", 10000, 0, 1, 100, nil},
		{"missing", nil, 0, 1, 0, nil},
		{"zero-elapsed", 10, 0, 0, 0, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := counterRate(Value{Value: tt.now}, Value{Value: tt.prev}, tt.dt, tt.speed)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("got %v", *got)
				}
			} else if got == nil || math.Abs(*got-*tt.want) > .0001 {
				t.Fatalf("got %v want %v", got, *tt.want)
			}
		})
	}
}
func ptr(n float64) *float64 { return &n }

func TestInterfaceRatesDiscardAgentRestartsAndStaleSamples(t *testing.T) {
	m := newMonitor(testConfig(), testSchema(t), nil)
	at := time.Now()
	s := &Snapshot{Scalars: map[string]Value{"sysUpTime": {Value: 100}}, Tables: map[string][]Row{"ifTable": {{Index: "1", Values: map[string]Value{"ifDescr": {Value: "em0"}, "ifInOctets": {Value: uint32(10)}, "ifOutOctets": {Value: uint32(10)}}}}}}
	if r := m.interfaces(s, at, true); r[0].RX != nil {
		t.Fatal("rate on first sample")
	}
	s.Tables["ifTable"][0].Values = map[string]Value{"ifDescr": {Value: "em0"}, "ifInOctets": {Value: uint32(110)}, "ifOutOctets": {Value: uint32(110)}}
	if r := m.interfaces(s, at.Add(10*time.Second), true); r[0].RX == nil || *r[0].RX != 10 {
		t.Fatalf("%+v", r)
	}
	s.Scalars["sysUpTime"] = Value{Value: 50}
	if r := m.interfaces(s, at.Add(20*time.Second), true); r[0].RX != nil {
		t.Fatal("rate across agent restart")
	}
	if r := m.interfaces(s, at.Add(10*time.Minute), true); r[0].RX != nil {
		t.Fatal("rate across stale sample")
	}
}

func TestHTTPEndpointsReadOnlyAndNoCredentials(t *testing.T) {
	m := newMonitor(testConfig(), testSchema(t), nil)
	handler := routes(m)
	for _, path := range []string{"/", "/app.js", "/style.css", "/api/snapshot", "/api/schema", "/api/objects", "/api/export", "/healthz", "/readyz", "/metrics"} {
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 200 {
			t.Fatalf("%s status %d", path, r.Code)
		}
		if strings.Contains(r.Body.String(), m.cfg.Community) {
			t.Fatalf("credential leaked: %s", path)
		}
		if r.Header().Get("Content-Security-Policy") == "" {
			t.Fatal("missing CSP")
		}
	}
	r := httptest.NewRecorder()
	handler.ServeHTTP(r, httptest.NewRequest("POST", "/api/snapshot", nil))
	if r.Code != 405 {
		t.Fatal("mutation accepted")
	}
	r = httptest.NewRecorder()
	handler.ServeHTTP(r, httptest.NewRequest("GET", "/api/snapshot", nil))
	var s Snapshot
	if err := json.Unmarshal(r.Body.Bytes(), &s); err != nil || s.State != "starting" {
		t.Fatal("invalid initial snapshot")
	}
}

func TestConfigValidation(t *testing.T) {
	t.Setenv("SNMP_TARGET", "localhost")
	t.Setenv("SNMP_COMMUNITY", "test-community")
	for _, tt := range []struct{ name, value string }{{"POLL_INTERVAL", "0s"}, {"POLL_TIMEOUT", "bad"}, {"SNMP_PORT", "65536"}, {"HISTORY_LIMIT", "1"}, {"SNMP_RETRIES", "-1"}, {"PORT", "0"}} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(tt.name, tt.value)
			if _, err := loadConfig(); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
	t.Setenv("SNMP_COMMUNITY", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("missing community accepted")
	}
}
