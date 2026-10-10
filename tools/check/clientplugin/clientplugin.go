// Package clientplugin checks device (JS) plugin packages with the same rules as the app's
// PluginPackage.validate (ADR-0018), so a public index can refuse what the app would refuse.
// spec/fixtures/client-plugins.json holds the vectors both sides run.
//
// The package imports nothing else from this module: the public plugin index vendors it
// (scripts/sync-plugin-checker.sh). Where the app counts characters, this counts runes, which is
// never fewer, so whatever passes here also passes in the app.
package clientplugin

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// AllowedFiles are the only files a package may hold.
var AllowedFiles = []string{"manifest.json", "main.js", "index.html", "styles.css"}

const (
	MaxFileBytes      = 2 << 20
	maxTabs           = 3
	maxCapabilities   = 32
	maxSettingFields  = 64
	maxPathBytes      = 200
	maxPathSegments   = 8
	maxPublishVersion = 32
)

var (
	ErrInvalid = errors.New("invalid plugin")

	idPattern         = regexp.MustCompile(`^[a-z][a-z0-9-]{1,39}$`)
	hostPattern       = regexp.MustCompile(`^[a-z0-9.-]{1,253}$`)
	segmentPattern    = regexp.MustCompile(`^[\p{L}\p{N}_-]+$`)
	settingKeyPattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,39}$`)
	// Public submissions only: the version becomes a folder name in the index.
	publishVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`)
	settingTypes          = []string{"string", "text", "number", "bool", "enum", "time", "list"}
)

// Tab is a tab or a sheet (same shape).
type Tab struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
}

type SettingField struct {
	Key     string   `json:"key"`
	Title   string   `json:"title"`
	Type    string   `json:"type"`
	Options []string `json:"options,omitempty"`
	Help    string   `json:"help,omitempty"`
}

type SettingsPage struct {
	Title string `json:"title"`
}

type Manifest struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Version      string         `json:"version"`
	Description  string         `json:"description"`
	Author       string         `json:"author,omitempty"`
	Render       string         `json:"render"`
	Tabs         []Tab          `json:"tabs"`
	Capabilities []string       `json:"capabilities"`
	Settings     []SettingField `json:"settings,omitempty"`
	Sheets       []Tab          `json:"sheets,omitempty"`
	SettingsPage *SettingsPage  `json:"settingsPage,omitempty"`
}

// Package is a validated package.
type Package struct {
	Manifest Manifest
	// Hash identifies the whole package (what the app stores it under).
	Hash string
	// Files maps each file name to its sha256 (hex).
	Files map[string]string
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Validate checks a package the way the app does before installing it.
func Validate(files map[string][]byte) (Package, error) {
	for name, data := range files {
		if !slices.Contains(AllowedFiles, name) {
			return Package{}, invalid("unexpected file %s", name)
		}
		if len(data) > MaxFileBytes {
			return Package{}, invalid("%s is over %d MB", name, MaxFileBytes>>20)
		}
	}
	raw, ok := files["manifest.json"]
	if _, hasMain := files["main.js"]; !ok || !hasMain {
		return Package{}, invalid("a plugin needs manifest.json and main.js")
	}
	manifest, err := decodeManifest(raw)
	if err != nil {
		return Package{}, err
	}
	if err := validateManifest(manifest); err != nil {
		return Package{}, err
	}
	hashes := map[string]string{}
	for name, data := range files {
		hashes[name] = FileHash(data)
	}
	return Package{Manifest: manifest, Hash: Hash(files), Files: hashes}, nil
}

// ValidatePublish adds the public index's rules: a version that is safe as a folder name.
func ValidatePublish(files map[string][]byte) (Package, error) {
	pkg, err := Validate(files)
	if err != nil {
		return pkg, err
	}
	if len(pkg.Manifest.Version) > maxPublishVersion || !publishVersionPattern.MatchString(pkg.Manifest.Version) {
		return Package{}, invalid("version must look like 1.2.3 (optionally -beta.1), at most %d characters", maxPublishVersion)
	}
	return pkg, nil
}

// decodeManifest matches Swift's Decodable rather than encoding/json: keys are exact (encoding/json
// also takes "ID" for "id"), required keys must be present and non-null, array elements can't be
// null, and unknown keys are ignored. A key given twice is refused outright, so no reader can
// pick a different copy than the index listed.
func decodeManifest(raw []byte) (Manifest, error) {
	m, err := decodeManifestFields(raw)
	if err != nil {
		return Manifest{}, invalid("manifest.json: %v", err)
	}
	return m, nil
}

func decodeManifestFields(raw []byte) (Manifest, error) {
	var m Manifest
	top, err := object(raw)
	if err != nil {
		return m, err
	}
	for key, target := range map[string]*string{"id": &m.ID, "name": &m.Name, "version": &m.Version, "description": &m.Description, "render": &m.Render} {
		if *target, err = str(top, key, true); err != nil {
			return m, err
		}
	}
	if m.Author, err = str(top, "author", false); err != nil {
		return m, err
	}
	if m.Capabilities, err = strs(top, "capabilities", true); err != nil {
		return m, err
	}
	if m.Tabs, err = tabs(top, "tabs", true); err != nil {
		return m, err
	}
	if m.Sheets, err = tabs(top, "sheets", false); err != nil {
		return m, err
	}
	settings, err := objects(top, "settings", false)
	if err != nil {
		return m, err
	}
	for _, field := range settings {
		var f SettingField
		if f.Key, err = str(field, "key", true); err != nil {
			return m, err
		}
		if f.Title, err = str(field, "title", true); err != nil {
			return m, err
		}
		if f.Type, err = str(field, "type", true); err != nil {
			return m, err
		}
		if f.Options, err = strs(field, "options", false); err != nil {
			return m, err
		}
		if f.Help, err = str(field, "help", false); err != nil {
			return m, err
		}
		m.Settings = append(m.Settings, f)
	}
	if value, ok := present(top, "settingsPage"); ok {
		page, err := object(value)
		if err != nil {
			return m, fmt.Errorf("settingsPage: %w", err)
		}
		title, err := str(page, "title", true)
		if err != nil {
			return m, fmt.Errorf("settingsPage: %w", err)
		}
		m.SettingsPage = &SettingsPage{Title: title}
	}
	return m, nil
}

// object reads one JSON object with exact, unique keys.
func object(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, errors.New("expected an object")
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key := token.(string) // object keys are always strings
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if _, dup := fields[key]; dup {
			return nil, fmt.Errorf("%s appears twice", key)
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the object")
	}
	return fields, nil
}

// present is a key's value unless it is missing or null (Swift treats both as absent).
func present(fields map[string]json.RawMessage, key string) (json.RawMessage, bool) {
	value, ok := fields[key]
	if !ok || string(value) == "null" {
		return nil, false
	}
	return value, true
}

func str(fields map[string]json.RawMessage, key string, required bool) (string, error) {
	value, ok := present(fields, key)
	if !ok {
		if required {
			return "", fmt.Errorf("%s is missing", key)
		}
		return "", nil
	}
	var out string
	if value[0] != '"' || json.Unmarshal(value, &out) != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return out, nil
}

func strs(fields map[string]json.RawMessage, key string, required bool) ([]string, error) {
	items, err := array(fields, key, required)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		var s string
		if item[0] != '"' || json.Unmarshal(item, &s) != nil {
			return nil, fmt.Errorf("%s must hold strings", key)
		}
		out = append(out, s)
	}
	return out, nil
}

func objects(fields map[string]json.RawMessage, key string, required bool) ([]map[string]json.RawMessage, error) {
	items, err := array(fields, key, required)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]json.RawMessage, 0, len(items))
	for _, item := range items {
		o, err := object(item)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", key, err)
		}
		out = append(out, o)
	}
	return out, nil
}

func tabs(fields map[string]json.RawMessage, key string, required bool) ([]Tab, error) {
	items, err := objects(fields, key, required)
	if err != nil {
		return nil, err
	}
	out := make([]Tab, 0, len(items))
	for _, item := range items {
		var tab Tab
		for name, target := range map[string]*string{"id": &tab.ID, "title": &tab.Title, "icon": &tab.Icon} {
			if *target, err = str(item, name, true); err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
		}
		out = append(out, tab)
	}
	return out, nil
}

func array(fields map[string]json.RawMessage, key string, required bool) ([]json.RawMessage, error) {
	value, ok := present(fields, key)
	if !ok {
		if required {
			return nil, fmt.Errorf("%s is missing", key)
		}
		return nil, nil
	}
	var items []json.RawMessage
	if value[0] != '[' || json.Unmarshal(value, &items) != nil {
		return nil, fmt.Errorf("%s must be a list", key)
	}
	return items, nil
}

func validateManifest(m Manifest) error {
	if !idPattern.MatchString(m.ID) {
		return invalid("id must be lowercase letters, digits and -")
	}
	if strings.TrimSpace(m.Name) == "" || utf8.RuneCountInString(m.Name) > 60 {
		return invalid("name")
	}
	if m.Render != "web" && m.Render != "native" {
		return invalid("render must be web or native")
	}
	for _, group := range []struct {
		kind    string
		entries []Tab
	}{{"tab", m.Tabs}, {"sheet", m.Sheets}} {
		if len(group.entries) > maxTabs {
			return invalid("at most %d %ss", maxTabs, group.kind)
		}
		seen := map[string]bool{}
		for _, entry := range group.entries {
			if seen[entry.ID] {
				return invalid("%s ids must be unique", group.kind)
			}
			seen[entry.ID] = true
			if !idPattern.MatchString(entry.ID) || entry.Title == "" || utf8.RuneCountInString(entry.Title) > 20 || entry.Icon == "" {
				return invalid("%s %s", group.kind, entry.ID)
			}
		}
	}
	if page := m.SettingsPage; page != nil && (page.Title == "" || utf8.RuneCountInString(page.Title) > 30) {
		return invalid("settingsPage title")
	}
	if err := validateSettings(m.Settings); err != nil {
		return err
	}
	if len(m.Capabilities) > maxCapabilities {
		return invalid("too many capabilities")
	}
	for _, capability := range m.Capabilities {
		if !ValidCapability(capability) {
			return invalid("unknown capability %s", capability)
		}
	}
	return nil
}

func validateSettings(fields []SettingField) error {
	if len(fields) > maxSettingFields {
		return invalid("at most %d settings", maxSettingFields)
	}
	seen := map[string]bool{}
	for _, field := range fields {
		switch {
		case !settingKeyPattern.MatchString(field.Key) || field.Key == "token":
			return invalid("setting key %s", field.Key)
		case seen[field.Key]:
			return invalid("setting %s twice", field.Key)
		case !slices.Contains(settingTypes, field.Type):
			return invalid("setting %s has unknown type %s", field.Key, field.Type)
		case field.Type == "enum" && (len(field.Options) == 0 || len(field.Options) > 32):
			return invalid("enum setting %s needs 1–32 options", field.Key)
		case len(field.Title) > 80 || len(field.Help) > 300:
			return invalid("setting %s title/help", field.Key)
		}
		seen[field.Key] = true
	}
	return nil
}

// ValidID reports whether id is a valid plugin (or tab) id.
func ValidID(id string) bool {
	return idPattern.MatchString(id)
}

// ValidCapability reports whether the app knows a capability.
func ValidCapability(capability string) bool {
	switch capability {
	case "todos:read", "todos:write", "storage":
		return true
	}
	if host, ok := strings.CutPrefix(capability, "net:"); ok {
		return hostPattern.MatchString(host)
	}
	for _, prefix := range []string{"notes:read:", "notes:write:"} {
		if path, ok := strings.CutPrefix(capability, prefix); ok {
			canonical, valid := canonicalPath(path)
			return path == "*" || (valid && canonical == path)
		}
	}
	return false
}

// canonicalPath mirrors notes.CanonicalPath (a test keeps them equal).
func canonicalPath(raw string) (string, bool) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", false
	}
	segments := strings.Split(trimmed, "/")
	if len(segments) > maxPathSegments {
		return "", false
	}
	for i, segment := range segments {
		segment = strings.ToLower(strings.Join(strings.FieldsFunc(segment, unicode.IsSpace), "-"))
		if !segmentPattern.MatchString(segment) {
			return "", false
		}
		segments[i] = segment
	}
	path := strings.Join(segments, "/")
	return path, len(path) <= maxPathBytes
}

// Hash is one sha256 over every file's name and hex sha256, in name order (PluginPackage.hash).
func Hash(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	hasher := sha256.New()
	for _, name := range names {
		hasher.Write([]byte(name))
		hasher.Write([]byte(FileHash(files[name])))
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func FileHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
