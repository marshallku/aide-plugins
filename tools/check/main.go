// Command aide-plugin-check validates a device plugin package folder the way the app does and
// prints what an index needs to list it. The public plugin index vendors this command.
//
//	aide-plugin-check [--publish] <dir>
//
// Output (stdout, one JSON object): {"ok": true, "id", "version", "hash", "files", "capabilities"}
// or {"ok": false, "error"}; the exit status is 1 when the package is refused.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"aide-plugin-check/clientplugin"
)

type result struct {
	OK           bool              `json:"ok"`
	Error        string            `json:"error,omitempty"`
	ID           string            `json:"id,omitempty"`
	Name         string            `json:"name,omitempty"`
	Description  string            `json:"description,omitempty"`
	Author       string            `json:"author,omitempty"`
	Version      string            `json:"version,omitempty"`
	Hash         string            `json:"hash,omitempty"`
	Files        map[string]string `json:"files,omitempty"`
	Capabilities []string          `json:"capabilities,omitempty"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("aide-plugin-check", flag.ContinueOnError)
	flags.SetOutput(stderr)
	publish := flags.Bool("publish", false, "also apply the public index's rules (version format)")
	if err := flags.Parse(args); err != nil || flags.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: aide-plugin-check [--publish] <dir>")
		return 2
	}
	out := check(flags.Arg(0), *publish)
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(out)
	if !out.OK {
		return 1
	}
	return 0
}

func check(dir string, publish bool) result {
	files, err := readDir(dir)
	if err != nil {
		return result{Error: err.Error()}
	}
	validate := clientplugin.Validate
	if publish {
		validate = clientplugin.ValidatePublish
	}
	pkg, err := validate(files)
	if err != nil {
		return result{Error: err.Error()}
	}
	m := pkg.Manifest
	return result{
		OK: true, ID: m.ID, Name: m.Name, Description: m.Description, Author: m.Author, Version: m.Version,
		Hash: pkg.Hash, Files: pkg.Files, Capabilities: m.Capabilities,
	}
}

// readDir reads every entry; anything that isn't a regular file is refused, and so is any file
// the app wouldn't install (Validate reports it by name).
func readDir(dir string) (map[string][]byte, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			return nil, fmt.Errorf("%s is not a regular file", entry.Name())
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if info.Size() > clientplugin.MaxFileBytes {
			return nil, errors.New(entry.Name() + " is over 2 MB")
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		files[entry.Name()] = data
	}
	return files, nil
}
