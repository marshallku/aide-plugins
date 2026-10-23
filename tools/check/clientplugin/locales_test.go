package clientplugin

import (
	"encoding/json"
	"errors"
	"testing"
)

// A device plugin's locales translate only what the app shows from it; its catalog keeps each
// translation's arguments.
func TestDevicePluginTranslations(t *testing.T) {
	base := func() Manifest {
		var m Manifest
		raw := `{"id": "pomo", "name": "Pomodoro", "version": "1.0.0", "description": "Focus", "render": "native",
			"tabs": [{"id": "timer", "title": "Focus", "icon": "timer"}], "capabilities": ["storage"],
			"settings": [{"key": "mode", "title": "Mode", "type": "enum", "options": ["short", "long"]}],
			"commands": [{"id": "start", "title": "Start"}]}`
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	good := base()
	good.Locales = map[string]map[string]any{"ko": {"name": "뽀모도로", "tabs.timer.title": "집중",
		"commands.start.title": "시작", "settings.mode.options": []any{"짧게", "길게"}}}
	good.Strings = map[string]any{"%lld sessions": map[string]any{"en": map[string]any{"one": "%lld session", "other": "%lld sessions"}, "ko": "%lld회"},
		"Start": "시작"}
	if err := validateManifest(good); err != nil {
		t.Fatalf("good translations refused: %v", err)
	}
	for name, change := range map[string]func(*Manifest){
		"a tab it doesn't have":       func(m *Manifest) { m.Locales = map[string]map[string]any{"ko": {"tabs.gone.title": "x"}} },
		"a settings page it lacks":    func(m *Manifest) { m.Locales = map[string]map[string]any{"ko": {"settingsTitle": "x"}} },
		"labels for each option":      func(m *Manifest) { m.Locales = map[string]map[string]any{"ko": {"settings.mode.options": []any{"x"}}} },
		"an unknown path":             func(m *Manifest) { m.Locales = map[string]map[string]any{"ko": {"footer": "x"}} },
		"a form with other arguments": func(m *Manifest) { m.Strings = map[string]any{"%@ done": "완료"} },
		"a %lf":                       func(m *Manifest) { m.Strings = map[string]any{"%lf": "x"} },
		"an unknown form":             func(m *Manifest) { m.Strings = map[string]any{"x": map[string]any{"fr": "y"}} },
	} {
		m := base()
		change(&m)
		if err := validateManifest(m); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
