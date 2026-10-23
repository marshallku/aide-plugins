package clientplugin

import (
	"encoding/json"
	"os"
	"testing"
)

// The same vectors the app's ClientPluginTests run.
type fixture struct {
	Name    string            `json:"name"`
	Files   map[string]string `json:"files"`
	Hash    *string           `json:"hash"`
	Publish bool              `json:"publish"`
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()
	data, err := os.ReadFile("../testdata/client-plugins.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Validate []fixture `json:"validate"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Validate) < 30 {
		t.Fatalf("only %d fixtures", len(f.Validate))
	}
	return f.Validate
}

func TestFixtures(t *testing.T) {
	for _, tc := range loadFixtures(t) {
		t.Run(tc.Name, func(t *testing.T) {
			files := map[string][]byte{}
			for name, body := range tc.Files {
				files[name] = []byte(body)
			}
			pkg, err := Validate(files)
			switch {
			case tc.Hash == nil && err == nil:
				t.Fatalf("accepted, want refused")
			case tc.Hash != nil && err != nil:
				t.Fatalf("refused: %v", err)
			case tc.Hash != nil && pkg.Hash != *tc.Hash:
				t.Fatalf("hash %s, want %s", pkg.Hash, *tc.Hash)
			}
			if _, err := ValidatePublish(files); (err == nil) != tc.Publish {
				t.Fatalf("publish error %v, want publishable=%v", err, tc.Publish)
			}
		})
	}
}

func TestFileHashesListEveryFile(t *testing.T) {
	files := map[string][]byte{
		"manifest.json": []byte(`{"id":"hello","name":"Hello","version":"1.0.0","description":"","render":"web","tabs":[],"capabilities":[]}`),
		"main.js":       []byte("x"),
	}
	pkg, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	if len(pkg.Files) != 2 || pkg.Files["main.js"] != FileHash([]byte("x")) {
		t.Fatalf("files %v", pkg.Files)
	}
}

func TestOversizedFileIsRefused(t *testing.T) {
	files := map[string][]byte{"manifest.json": []byte("{}"), "main.js": make([]byte, MaxFileBytes+1)}
	if _, err := Validate(files); err == nil {
		t.Fatal("accepted a 2 MB+ file")
	}
}

func TestAKeyGivenTwiceIsRefused(t *testing.T) {
	for _, manifest := range []string{
		`{"id":"hello","id":"other","name":"H","version":"1.0.0","description":"","render":"web","tabs":[],"capabilities":[]}`,
		`{"id":"hello","name":"H","version":"1.0.0","description":"","render":"web","tabs":[],"capabilities":["storage"],"capabilities":[]}`,
		`{"id":"hello","name":"H","version":"1.0.0","description":"","render":"web","tabs":[{"id":"main","id":"x","title":"T","icon":"i"}],"capabilities":[]}`,
	} {
		if _, err := Validate(map[string][]byte{"manifest.json": []byte(manifest), "main.js": []byte("x")}); err == nil {
			t.Errorf("accepted %s", manifest)
		}
	}
}

// The index's strict check reads a package's translations too: a broken one is refused.
func TestValidatePublishChecksTranslations(t *testing.T) {
	manifest := func(extra string) map[string][]byte {
		return map[string][]byte{
			"manifest.json": []byte(`{"id":"hello","name":"Hello","version":"1.0.0","description":"","render":"web","tabs":[],"capabilities":[]` + extra + `}`),
			"main.js":       []byte("1"),
		}
	}
	if _, err := ValidatePublish(manifest(`,"locales":{"ko":{"name":"안녕"}},"strings":{"Hi":"안녕"}`)); err != nil {
		t.Fatalf("good translations refused: %v", err)
	}
	for name, extra := range map[string]string{
		"locales not an object":     `,"locales":123`,
		"a language not an object":  `,"locales":{"ko":"안녕"}`,
		"an unknown locale path":    `,"locales":{"ko":{"nickname":"x"}}`,
		"strings not an object":     `,"strings":["x"]`,
		"a translation's arguments": `,"strings":{"%@ items":"%lld개"}`,
	} {
		if _, err := ValidatePublish(manifest(extra)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
