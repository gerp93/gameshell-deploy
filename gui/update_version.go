package main

import (
	"regexp"
	"strconv"
	"strings"
)

var updateVersionDigits = regexp.MustCompile(`\d+`)

func parseUpdateVersion(text string) [3]int {
	core := strings.TrimPrefix(strings.TrimSpace(text), "v")
	if i := strings.Index(core, "-"); i >= 0 {
		core = core[:i]
	}
	pieces := strings.Split(core, ".")
	var out [3]int
	for i := 0; i < 3; i++ {
		if i >= len(pieces) {
			break
		}
		digits := updateVersionDigits.FindString(pieces[i])
		if digits == "" {
			continue
		}
		n, _ := strconv.Atoi(digits)
		out[i] = n
	}
	return out
}

func updateVersionLess(current, latest string) bool {
	a, b := parseUpdateVersion(current), parseUpdateVersion(latest)
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}
