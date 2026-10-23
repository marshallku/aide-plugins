package clientplugin

import (
	"encoding/json"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A device plugin's translations (i18n/README.md › Plugins): `locales` per language map what the
// app shows from the manifest — name, description, settingsTitle, tabs/sheets/panels/commands
// titles by id, settings titles, help and option labels (the options themselves are what's saved)
// — and `strings` is its catalog for aide.t, language-independent (English forms for plurals and
// contexts, Korean).
const (
	maxLocales       = 8
	maxLocaleEntries = 500
	maxStrings       = 500
	maxI18nBytes     = 64 << 10
)

var (
	languagePattern = regexp.MustCompile(`^[a-z]{2}(-[A-Z]{2})?$`)
	surfacePath     = regexp.MustCompile(`^(tabs|sheets|panels|commands)\.([a-z][a-z0-9-]{0,39})\.title$`)
	settingPath     = regexp.MustCompile(`^settings\.([a-zA-Z][a-zA-Z0-9_-]{0,39})\.(title|help|options)$`)
	specifier       = regexp.MustCompile(`%(?:(\d+)\$)?(@|lld)|%%|%`)
)

func text(value any, limit int) bool {
	s, ok := value.(string)
	return ok && strings.TrimSpace(s) != "" && utf8.RuneCountInString(s) <= limit
}

func validateLocales(m Manifest) error {
	if len(m.Locales) > maxLocales {
		return invalid("at most %d locales", maxLocales)
	}
	ids := map[string]map[string]bool{"tabs": {}, "sheets": {}, "panels": {}, "commands": {}}
	for kind, entries := range map[string][]Tab{"tabs": m.Tabs, "sheets": m.Sheets, "panels": m.Panels} {
		for _, entry := range entries {
			ids[kind][entry.ID] = true
		}
	}
	for _, command := range m.Commands {
		ids["commands"][command.ID] = true
	}
	fields := map[string]SettingField{}
	for _, field := range m.Settings {
		fields[field.Key] = field
	}
	for language, entries := range m.Locales {
		if !languagePattern.MatchString(language) {
			return invalid("locale %s isn't a language code", language)
		}
		if len(entries) > maxLocaleEntries {
			return invalid("locale %s has more than %d entries", language, maxLocaleEntries)
		}
		for path, value := range entries {
			ok := false
			switch {
			case path == "name":
				ok = text(value, 60)
			case path == "description":
				ok = text(value, 1000)
			case path == "settingsTitle":
				ok = m.SettingsPage != nil && text(value, 60)
			case surfacePath.MatchString(path):
				match := surfacePath.FindStringSubmatch(path)
				ok = ids[match[1]][match[2]] && text(value, 60)
			case settingPath.MatchString(path):
				match := settingPath.FindStringSubmatch(path)
				field, has := fields[match[1]]
				switch {
				case !has:
				case match[2] == "title":
					ok = text(value, 80)
				case match[2] == "help":
					ok = text(value, 300)
				default:
					labels, isList := value.([]any)
					ok = isList && field.Type == "enum" && len(labels) == len(field.Options) &&
						!slices.ContainsFunc(labels, func(label any) bool { return !text(label, 80) })
				}
			}
			if !ok {
				return invalid("locale %s: %s isn't something this plugin shows, or its text is too long", language, path)
			}
		}
	}
	return nil
}

// signature is what a catalog template takes ("1:@,2:lld"), or false when it isn't one (the
// rules of i18n/format.mjs).
func signature(template string) (string, bool) {
	types := map[int]string{}
	plain, numbered := 0, 0
	for _, match := range specifier.FindAllStringSubmatch(template, -1) {
		if match[0] == "%%" {
			continue
		}
		if match[2] == "" {
			return "", false
		}
		position := 0
		if match[1] != "" {
			numbered++
			position, _ = strconv.Atoi(match[1])
		} else {
			plain++
			position = plain
		}
		if known, seen := types[position]; seen && known != match[2] {
			return "", false
		}
		types[position] = match[2]
	}
	if plain > 0 && numbered > 0 {
		return "", false
	}
	parts := make([]string, 0, len(types))
	for position := 1; position <= len(types); position++ {
		kind, ok := types[position]
		if !ok {
			return "", false
		}
		parts = append(parts, strconv.Itoa(position)+":"+kind)
	}
	return strings.Join(parts, ","), true
}

func validateStrings(catalog map[string]any) error {
	if len(catalog) > maxStrings {
		return invalid("strings: at most %d", maxStrings)
	}
	if data, _ := json.Marshal(catalog); len(data) > maxI18nBytes {
		return invalid("strings: at most %d bytes", maxI18nBytes)
	}
	for key, entry := range catalog {
		want, ok := signature(key)
		if !ok || strings.TrimSpace(key) == "" {
			return invalid("strings: %q isn't a template", key)
		}
		forms := []any{}
		switch value := entry.(type) {
		case string:
			forms = append(forms, value)
		case map[string]any:
			for name, form := range value {
				switch name {
				case "note":
				case "en", "ko":
					if plural, isPlural := form.(map[string]any); isPlural {
						for _, text := range plural {
							forms = append(forms, text)
						}
					} else {
						forms = append(forms, form)
					}
				default:
					return invalid("strings: %q has an unknown %s", key, name)
				}
			}
		default:
			return invalid("strings: %q isn't a translation", key)
		}
		for _, form := range forms {
			s, isText := form.(string)
			if got, ok := signature(s); !isText || !ok || got != want {
				return invalid("strings: %q has a form with other arguments", key)
			}
		}
	}
	return nil
}
