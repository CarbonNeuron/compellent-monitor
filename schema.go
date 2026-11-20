package main

import (
	"embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gosnmp/gosnmp"
)

//go:embed mibs/schema.json web/*
var assets embed.FS

type Field struct {
	Name        string            `json:"name"`
	OID         string            `json:"oid"`
	Syntax      string            `json:"syntax"`
	Access      string            `json:"access"`
	Status      string            `json:"status"`
	Description string            `json:"description"`
	Table       string            `json:"table"`
	Enums       map[string]string `json:"enums"`
	Unit        string            `json:"unit"`
}
type TableDef struct {
	Name    string   `json:"name"`
	Label   string   `json:"label"`
	Group   string   `json:"group"`
	OID     string   `json:"oid"`
	Indexes []string `json:"indexes"`
}
type Schema struct {
	MIB      string     `json:"mib"`
	Revision string     `json:"revision"`
	Root     string     `json:"root"`
	Tables   []TableDef `json:"tables"`
	Fields   []Field    `json:"fields"`
	byOID    map[string]Field
}

func loadSchema() (*Schema, error) {
	b, err := assets.ReadFile("mibs/schema.json")
	if err != nil {
		return nil, err
	}
	s := &Schema{}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	s.Tables = append(s.Tables, TableDef{Name: "ifTable", Label: "Management interfaces", Group: "performance", OID: ".1.3.6.1.2.1.2.2", Indexes: []string{"ifIndex"}})
	sysNames := []string{"sysDescr", "sysObjectID", "sysUpTime", "sysContact", "sysName", "sysLocation", "sysServices", "sysORLastChange"}
	for i, name := range sysNames {
		s.Fields = append(s.Fields, Field{Name: name, OID: fmt.Sprintf(".1.3.6.1.2.1.1.%d", i+1), Syntax: "standard", Access: "read-only", Description: "SNMP system information"})
	}
	ifNames := []string{"ifIndex", "ifDescr", "ifType", "ifMtu", "ifSpeed", "ifPhysAddress", "ifAdminStatus", "ifOperStatus", "ifLastChange", "ifInOctets", "ifInUcastPkts", "ifInNUcastPkts", "ifInDiscards", "ifInErrors", "ifInUnknownProtos", "ifOutOctets", "ifOutUcastPkts", "ifOutNUcastPkts", "ifOutDiscards", "ifOutErrors", "ifOutQLen", "ifSpecific"}
	for i, name := range ifNames {
		f := Field{Name: name, OID: fmt.Sprintf(".1.3.6.1.2.1.2.2.1.%d", i+1), Table: "ifTable", Syntax: "standard", Access: "read-only", Description: "Agent network interface; these counters do not measure SAN volume I/O"}
		if name == "ifAdminStatus" || name == "ifOperStatus" {
			f.Enums = map[string]string{"1": "up", "2": "down", "3": "testing", "4": "unknown", "5": "dormant", "6": "notPresent", "7": "lowerLayerDown"}
		}
		if name == "ifSpeed" {
			f.Unit = "bit/s"
		}
		s.Fields = append(s.Fields, f)
	}
	for n, name := range map[int]string{1: "ifName", 6: "ifHCInOctets", 10: "ifHCOutOctets", 15: "ifHighSpeed", 18: "ifAlias", 19: "ifCounterDiscontinuityTime"} {
		s.Fields = append(s.Fields, Field{Name: name, OID: fmt.Sprintf(".1.3.6.1.2.1.31.1.1.1.%d", n), Table: "ifTable", Syntax: "standard", Access: "read-only", Description: "Extended agent network interface information"})
	}
	s.byOID = make(map[string]Field, len(s.Fields))
	for _, f := range s.Fields {
		s.byOID[f.OID] = f
	}
	return s, nil
}

type Value struct {
	Value any    `json:"value"`
	Label string `json:"label,omitempty"`
	Unit  string `json:"unit,omitempty"`
}
type Observation struct {
	OID   string `json:"oid"`
	Name  string `json:"name"`
	Index string `json:"index"`
	Table string `json:"table,omitempty"`
	Type  string `json:"type"`
	Value
}

func (s *Schema) decode(p gosnmp.SnmpPDU) Observation {
	o := Observation{OID: "." + strings.TrimPrefix(p.Name, "."), Type: p.Type.String()}
	parts := strings.Split(o.OID, ".")
	var f Field
	for n := len(parts) - 1; n > 1; n-- {
		if candidate, ok := s.byOID[strings.Join(parts[:n], ".")]; ok {
			f = candidate
			o.Name = f.Name
			o.Table = f.Table
			o.Index = strings.Join(parts[n:], ".")
			break
		}
	}
	if o.Name == "" {
		o.Name = o.OID
	}
	o.Unit = f.Unit
	switch v := p.Value.(type) {
	case []byte:
		if f.Syntax == "DateAndTime" {
			o.Value.Value = decodeDate(v)
		} else if f.Name == "ifPhysAddress" {
			o.Value.Value = hex.EncodeToString(v)
		} else if utf8.Valid(v) && !strings.ContainsRune(string(v), '\x00') {
			o.Value.Value = string(v)
		} else {
			o.Value.Value = "0x" + hex.EncodeToString(v)
		}
	case uint64:
		// Preserve all 64 bits in JSON. Browsers cannot represent arbitrary uint64s.
		o.Value.Value = strconv.FormatUint(v, 10)
	default:
		o.Value.Value = v
	}
	o.Label = f.Enums[fmt.Sprint(o.Value.Value)]
	return o
}

func decodeDate(v []byte) string {
	// Some SC firmware returns ISO text despite declaring DateAndTime.
	if utf8.Valid(v) && !strings.ContainsRune(string(v), '\x00') && len(v) != 8 && len(v) != 11 {
		return string(v)
	}
	if len(v) != 8 && len(v) != 11 {
		return "0x" + hex.EncodeToString(v)
	}
	if v[2] < 1 || v[2] > 12 || v[3] < 1 || v[3] > 31 {
		return "0x" + hex.EncodeToString(v)
	}
	t := fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d.%d", binary.BigEndian.Uint16(v[:2]), v[2], v[3], v[4], v[5], v[6], v[7])
	if len(v) == 11 {
		t += fmt.Sprintf("%c%02d:%02d", v[8], v[9], v[10])
	}
	return t
}

func number(v any) float64 {
	n, _ := strconv.ParseFloat(fmt.Sprint(v), 64)
	return n
}

func severity(label string) string {
	switch strings.ToLower(label) {
	case "up", "ok", "okay", "normal", "complete":
		return "ok"
	case "degraded", "noncritical", "partial", "expirationpending":
		return "warning"
	case "down", "critical", "nonrecoverable", "emergency", "expired", "unavailable", "lowerlayerdown":
		return "critical"
	default:
		return "unknown"
	}
}
