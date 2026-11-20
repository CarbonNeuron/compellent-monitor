package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Target, Community, Listen          string
	Port                               uint16
	Timeout, PollInterval, PollTimeout time.Duration
	Retries, HistoryLimit              int
	MaxRepetitions                     uint32
}

func loadConfig() (Config, error) {
	c := Config{Target: strings.TrimSpace(os.Getenv("SNMP_TARGET")), Community: os.Getenv("SNMP_COMMUNITY"), Listen: ":3000", Port: 161, Timeout: 2 * time.Second, PollInterval: 30 * time.Second, PollTimeout: 25 * time.Second, Retries: 1, HistoryLimit: 720, MaxRepetitions: 25}
	if c.Target == "" || c.Community == "" {
		return c, fmt.Errorf("SNMP_TARGET and SNMP_COMMUNITY are required")
	}
	for _, spec := range []struct {
		name     string
		dst      *time.Duration
		min, max time.Duration
	}{
		{"SNMP_TIMEOUT", &c.Timeout, 100 * time.Millisecond, 30 * time.Second},
		{"POLL_INTERVAL", &c.PollInterval, 5 * time.Second, time.Hour},
		{"POLL_TIMEOUT", &c.PollTimeout, time.Second, 5 * time.Minute},
	} {
		if v := os.Getenv(spec.name); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil || d < spec.min || d > spec.max {
				return c, fmt.Errorf("%s must be a duration between %s and %s", spec.name, spec.min, spec.max)
			}
			*spec.dst = d
		}
	}
	for _, spec := range []struct {
		name     string
		min, max int
		apply    func(int)
	}{
		{"SNMP_PORT", 1, 65535, func(v int) { c.Port = uint16(v) }},
		{"PORT", 1, 65535, func(v int) { c.Listen = ":" + strconv.Itoa(v) }},
		{"SNMP_RETRIES", 0, 5, func(v int) { c.Retries = v }},
		{"SNMP_MAX_REPETITIONS", 1, 100, func(v int) { c.MaxRepetitions = uint32(v) }},
		{"HISTORY_LIMIT", 2, 10000, func(v int) { c.HistoryLimit = v }},
	} {
		if v := os.Getenv(spec.name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < spec.min || n > spec.max {
				return c, fmt.Errorf("%s must be an integer between %d and %d", spec.name, spec.min, spec.max)
			}
			spec.apply(n)
		}
	}
	return c, nil
}
