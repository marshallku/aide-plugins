package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writePackage(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	manifest := `{"id":"hello","name":"Hello","version":"` + version + `","description":"d","render":"web","tabs":[],"capabilities":["storage"]}`
	for name, body := range map[string]string{"manifest.json": manifest, "main.js": "x"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func runCheck(t *testing.T, args ...string) (int, result) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr)
	var out result
	if code != 2 {
		if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
			t.Fatalf("output %q: %v", stdout.String(), err)
		}
	}
	return code, out
}

func TestCheckReportsWhatAnIndexNeeds(t *testing.T) {
	code, out := runCheck(t, "--publish", writePackage(t, "1.2.3"))
	if code != 0 || !out.OK || out.ID != "hello" || out.Version != "1.2.3" || len(out.Hash) != 64 || len(out.Files) != 2 {
		t.Fatalf("code %d, %+v", code, out)
	}
}

func TestPublishRefusesAPathLikeVersion(t *testing.T) {
	dir := writePackage(t, "../x")
	if code, _ := runCheck(t, dir); code != 0 {
		t.Fatalf("plain check refused it (code %d)", code)
	}
	if code, out := runCheck(t, "--publish", dir); code != 1 || out.OK {
		t.Fatalf("publish accepted: %+v", out)
	}
}

func TestExtraFilesAndFoldersAreRefused(t *testing.T) {
	dir := writePackage(t, "1.0.0")
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code, _ := runCheck(t, dir); code != 1 {
		t.Fatalf("folder accepted (code %d)", code)
	}
	dir = writePackage(t, "1.0.0")
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("x"), 0o644)
	if code, _ := runCheck(t, dir); code != 1 {
		t.Fatalf("README accepted (code %d)", code)
	}
}

func TestUsage(t *testing.T) {
	if code, _ := runCheck(t); code != 2 {
		t.Fatalf("code %d", code)
	}
}
