//go:generate go install -v github.com/kevinburke/go-bindata/v4/go-bindata
//go:generate go-bindata -prefix res/ -pkg assets -o assets/assets.go res/WhatsApp.lnk
//go:generate go install -v github.com/josephspurrier/goversioninfo/cmd/goversioninfo
//go:generate goversioninfo -icon=res/papp.ico -manifest=res/papp.manifest
package main

import (
	"fmt"
	"hash/fnv"
	"os"
	"os/exec"
	"path"
	"strings"

	"github.com/portapps/portapps/v3"
	"github.com/portapps/portapps/v3/pkg/log"
	"github.com/portapps/portapps/v3/pkg/mutex"
	"github.com/portapps/portapps/v3/pkg/shortcut"
	"github.com/portapps/portapps/v3/pkg/utl"
	"github.com/portapps/whatsapp-portable/assets"
)

type config struct {
	Cleanup        bool `yaml:"cleanup" mapstructure:"cleanup"`
	DisableGPU     bool `yaml:"disable_gpu" mapstructure:"disable_gpu"`
	ClearGPUCache  bool `yaml:"clear_gpu_cache" mapstructure:"clear_gpu_cache"`
	StartMinimized bool `yaml:"start_minimized" mapstructure:"start_minimized"`
}

var (
	app *portapps.App
	cfg *config
)

// Chromium caches tied to the GPU/driver. When they get stale (driver update, portable
// folder moved to another PC) the window renders black. They are safe to delete.
var gpuCacheFolders = []string{
	"GPUCache",
	"ShaderCache",
	"GrShaderCache",
	"GraphiteDawnCache",
	"DawnCache",
	"DawnGraphiteCache",
	"DawnWebGPUCache",
}

func init() {
	var err error

	// Default config
	cfg = &config{
		Cleanup:        false,
		DisableGPU:     false,
		ClearGPUCache:  true,
		StartMinimized: false,
	}

	// Init app
	if app, err = portapps.NewWithCfg("whatsapp-portable", "WhatsApp", cfg); err != nil {
		log.Fatal().Err(err).Msg("Cannot initialize application. See log file for more info.")
	}
}

func main() {
	utl.CreateFolder(app.DataPath)

	app.Process = utl.PathJoin(app.AppPath, "WhatsApp.exe")
	app.WorkingDir = app.AppPath
	app.Args = []string{
		"--user-data-dir=" + app.DataPath,
	}
	if cfg.DisableGPU {
		app.Args = append(app.Args, "--disable-gpu", "--disable-gpu-compositing")
	}
	if cfg.StartMinimized {
		app.Args = append(app.Args, "--start-minimized")
	}

	// Single instance: if this portable copy is already running, just bring its window
	// to the front (WhatsApp.exe forwards to the running instance and exits).
	mu, err := mutex.Create(mutexName())
	if err != nil {
		log.Info().Msg("WhatsApp portable is already running, focusing existing window")
		focusRunningInstance()
		return
	}
	defer func() {
		if err := mutex.Release(mu); err != nil {
			log.Error().Err(err).Msg("Cannot release mutex")
		}
	}()

	if cfg.ClearGPUCache {
		clearGPUCache()
	}

	// Cleanup on exit
	if cfg.Cleanup {
		defer func() {
			utl.Cleanup([]string{
				path.Join(os.Getenv("APPDATA"), "WhatsApp"),
			})
		}()
	}

	// Copy default shortcut
	shortcutPath := path.Join(utl.StartMenuPath(), "WhatsApp Portable.lnk")
	defaultShortcut, err := assets.Asset("WhatsApp.lnk")
	if err != nil {
		log.Error().Err(err).Msg("Cannot load asset WhatsApp.lnk")
	}
	err = os.WriteFile(shortcutPath, defaultShortcut, 0644)
	if err != nil {
		log.Error().Err(err).Msg("Cannot write default shortcut")
	}

	// Update default shortcut
	err = shortcut.Create(shortcut.Shortcut{
		ShortcutPath:     shortcutPath,
		TargetPath:       app.Process,
		Arguments:        shortcut.Property{Clear: true},
		Description:      shortcut.Property{Value: "WhatsApp Portable by Portapps"},
		IconLocation:     shortcut.Property{Value: app.Process},
		WorkingDirectory: shortcut.Property{Value: app.AppPath},
	})
	if err != nil {
		log.Error().Err(err).Msg("Cannot create shortcut")
	}
	defer func() {
		if err := os.Remove(shortcutPath); err != nil {
			log.Error().Err(err).Msg("Cannot remove shortcut")
		}
	}()

	defer app.Close()
	app.Launch(os.Args[1:])
}

// mutexName is unique per portable copy, so separate copies (e.g. different accounts)
// can still run side by side.
func mutexName() string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(strings.ToLower(app.RootPath)))
	return fmt.Sprintf("%s-%x", app.ID, h.Sum64())
}

func focusRunningInstance() {
	if !utl.Exists(app.Process) {
		return
	}
	cmd := exec.Command(app.Process, append(app.Args, os.Args[1:]...)...)
	cmd.Dir = app.WorkingDir
	if err := cmd.Start(); err != nil {
		log.Error().Err(err).Msg("Cannot signal running instance")
		return
	}
	_ = cmd.Process.Release()
}

func clearGPUCache() {
	for _, folder := range gpuCacheFolders {
		p := utl.PathJoin(app.DataPath, folder)
		if !utl.Exists(p) {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			log.Warn().Err(err).Msgf("Cannot remove %s", p)
			continue
		}
		log.Debug().Msgf("Removed GPU cache %s", p)
	}
}
