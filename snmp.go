package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

type Source struct {
	Name       string    `json:"name"`
	Root       string    `json:"root"`
	Count      int       `json:"count"`
	DurationMS int64     `json:"durationMs"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Error      string    `json:"error,omitempty"`
}

var sourceDefs = []Source{
	{Name: "Dell Storage Center", Root: ".1.3.6.1.4.1.674.11000.2000.500.1.2"},
	{Name: "SNMP system", Root: ".1.3.6.1.2.1.1"},
	{Name: "Management interfaces", Root: ".1.3.6.1.2.1.2.2"},
	{Name: "Extended interfaces", Root: ".1.3.6.1.2.1.31.1.1"},
}

type bulkClient interface {
	GetBulk([]string, uint8, uint32) (*gosnmp.SnmpPacket, error)
}

// Explicitly validate packet error status: some walk implementations return a
// successful truncated walk for agent errors. A failed walk must not erase data.
func walk(ctx context.Context, client bulkClient, root string, repetitions uint32) ([]gosnmp.SnmpPDU, error) {
	result := make([]gosnmp.SnmpPDU, 0)
	last := root
	for requests := 0; requests < 10000; requests++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		packet, err := client.GetBulk([]string{last}, 0, repetitions)
		if err != nil {
			return nil, err
		}
		if packet == nil {
			return nil, fmt.Errorf("agent returned an empty packet")
		}
		if packet.Error != gosnmp.NoError {
			if packet.Error == gosnmp.TooBig && repetitions > 1 {
				repetitions = max(1, repetitions/2)
				continue
			}
			return nil, fmt.Errorf("agent returned %s", packet.Error)
		}
		if len(packet.Variables) == 0 {
			return result, nil
		}
		for _, p := range packet.Variables {
			p.Name = "." + strings.TrimPrefix(p.Name, ".")
			if p.Type == gosnmp.EndOfMibView || p.Type == gosnmp.NoSuchObject || p.Type == gosnmp.NoSuchInstance || !strings.HasPrefix(p.Name, root+".") {
				return result, nil
			}
			if compareOID(p.Name, last) <= 0 {
				return nil, fmt.Errorf("agent returned a non-increasing OID")
			}
			result = append(result, p)
			last = p.Name
			if len(result) > 100000 {
				return nil, fmt.Errorf("walk exceeded 100000 objects")
			}
		}
	}
	return nil, fmt.Errorf("walk exceeded request limit")
}

func compareOID(a, b string) int {
	x, y := strings.Split(strings.TrimPrefix(a, "."), "."), strings.Split(strings.TrimPrefix(b, "."), ".")
	for i := 0; i < min(len(x), len(y)); i++ {
		u, _ := strconv.ParseUint(x[i], 10, 64)
		v, _ := strconv.ParseUint(y[i], 10, 64)
		if u < v {
			return -1
		}
		if u > v {
			return 1
		}
	}
	if len(x) < len(y) {
		return -1
	}
	if len(x) > len(y) {
		return 1
	}
	return 0
}

type walkSource func(context.Context, Source) ([]gosnmp.SnmpPDU, error)

func snmpWalker(c Config) walkSource {
	return func(ctx context.Context, src Source) ([]gosnmp.SnmpPDU, error) {
		client := &gosnmp.GoSNMP{Target: c.Target, Port: c.Port, Community: c.Community, Version: gosnmp.Version2c, Timeout: c.Timeout, Retries: c.Retries, Context: ctx, MaxRepetitions: c.MaxRepetitions}
		if err := client.Connect(); err != nil {
			return nil, err
		}
		defer client.Conn.Close()
		return walk(ctx, client, src.Root, c.MaxRepetitions)
	}
}
