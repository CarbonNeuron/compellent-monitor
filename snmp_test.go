package main

import (
	"context"
	"testing"

	"github.com/gosnmp/gosnmp"
)

type fakeBulk struct {
	packets  []*gosnmp.SnmpPacket
	requests []uint32
	oids     []string
}

func (f *fakeBulk) GetBulk(oids []string, _ uint8, repetitions uint32) (*gosnmp.SnmpPacket, error) {
	f.requests = append(f.requests, repetitions)
	f.oids = append(f.oids, oids[0])
	if len(f.packets) == 0 {
		panic("unexpected request")
	}
	p := f.packets[0]
	f.packets = f.packets[1:]
	return p, nil
}
func packet(oid string) *gosnmp.SnmpPacket {
	return &gosnmp.SnmpPacket{Variables: []gosnmp.SnmpPDU{{Name: oid, Type: gosnmp.Integer, Value: 1}}}
}
func TestWalkStopsAtSubtreeBoundary(t *testing.T) {
	f := &fakeBulk{packets: []*gosnmp.SnmpPacket{packet(".1.3.6.1.4.1"), packet(".1.3.6.1.5.1")}}
	r, e := walk(context.Background(), f, ".1.3.6.1.4", 25)
	if e != nil || len(r) != 1 || f.oids[1] != ".1.3.6.1.4.1" {
		t.Fatalf("%v %v", r, e)
	}
}
func TestWalkReducesTooBigResponses(t *testing.T) {
	f := &fakeBulk{packets: []*gosnmp.SnmpPacket{{Error: gosnmp.TooBig}, packet(".1.3.6.1.5")}}
	_, e := walk(context.Background(), f, ".1.3.6.1.4", 25)
	if e != nil || f.requests[1] != 12 || f.oids[0] != f.oids[1] {
		t.Fatalf("%+v %v", f, e)
	}
}
func TestWalkRejectsAgentErrorAndNonIncreasingOID(t *testing.T) {
	for _, packets := range [][]*gosnmp.SnmpPacket{{{Error: gosnmp.AuthorizationError}}, {packet(".1.3.6.1.4.1"), packet(".1.3.6.1.4.1")}, {{Error: gosnmp.TooBig}}} {
		f := &fakeBulk{packets: packets}
		r, e := walk(context.Background(), f, ".1.3.6.1.4", 1)
		if e == nil || r != nil {
			t.Fatalf("%v %v", r, e)
		}
	}
}
func TestWalkCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := walk(ctx, &fakeBulk{}, ".1.3.6.1.4", 25); err == nil {
		t.Fatal("cancel ignored")
	}
}
func TestOIDComparisonNumeric(t *testing.T) {
	if compareOID("1.12", "1.2") <= 0 || compareOID("1.2", "1.2.1") >= 0 || compareOID(".1.2", "1.2") != 0 {
		t.Fatal("numeric comparison incorrect")
	}
}
