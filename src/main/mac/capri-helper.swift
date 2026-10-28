// Watches the other windows and the app in front, on macOS, so Capri can sit on them and know
// what you're on. The macOS twin of windows.ps1: one JSON line on stdout whenever something
// changes. No Accessibility permission, no Screen Recording: CGWindowList gives the bounds and
// owner of the windows without either (never their titles, never their contents).
//
//   capri-helper <capri pid>
//
// {"t":"wins","fg":<window id>,"taskbar":false,"wins":[{"id","x","y","w","h","fs","pid","owner"}]}
//    the windows on screen in z-order (front first), in points from the top left of the main
//    display (the same coordinates as Electron's screen); fs: it's full screen (its own Space)
// {"t":"app","name","bundleId","pid","fullscreen"}   the app in front changed (or went full screen)
// {"t":"space"}                                      another Space came up
// {"t":"quit","name","bundleId"}                     an app quit
// {"t":"usb","name"}                                 a USB device was plugged in (IOKit, no permission)
// {"t":"mount","name","path"}                        a disk or volume showed up (not disk images)
//
// Build: node scripts/build-mac-helper.js (swiftc, a universal binary next to this file)

import AppKit
import CoreGraphics
import Foundation
import IOKit

setvbuf(stdout, nil, _IOLBF, 0)

let parentPid = CommandLine.arguments.count > 1 ? pid_t(CommandLine.arguments[1]) ?? 0 : 0

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

struct Display {
  let bounds: CGRect // in the same top-left-origin points as the windows
  let notch: CGFloat // the strip at the top a full-screen window leaves out (the camera housing), or 0
  var desktop = false // its wallpaper is on screen: not a full-screen Space
}

func displays() -> [Display] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  var notches: [CGDirectDisplayID: CGFloat] = [:]
  for screen in NSScreen.screens {
    if let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
      notches[id.uint32Value] = screen.safeAreaInsets.top
    }
  }
  return ids.prefix(Int(count)).map { Display(bounds: CGDisplayBounds($0), notch: notches[$0] ?? 0) }
}

func same(_ a: CGRect, _ b: CGRect) -> Bool {
  abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
}

// A full-screen window: the whole of its display (less the notch), on a Space with no wallpaper
// (a zoomed window can be just as big, the Dock hidden, but the desktop is behind it).
func fullScreen(_ r: CGRect, _ displays: [Display]) -> Bool {
  displays.contains { d in
    !d.desktop && (same(r, d.bounds) || same(r, CGRect(x: d.bounds.minX, y: d.bounds.minY + d.notch, width: d.bounds.width, height: d.bounds.height - d.notch)))
  }
}

struct Win {
  let id: Int
  let pid: pid_t
  let owner: String
  let rect: CGRect
  let layer: Int
  let fs: Bool
}

func bounds(_ info: [String: Any]) -> CGRect? {
  guard let dict = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: dict as CFDictionary)
}

// Normal windows (and floating ones: layers under the Dock's), on screen, front first.
// Minimized windows and the ones on other Spaces aren't on screen: they're left out, as on Windows.
func windows() -> [Win] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var screens = displays()
  // the wallpaper (the Dock's before macOS 14) and Finder's desktop icons, under everything
  let desktopLevel = Int(CGWindowLevelForKey(.desktopIconWindow))
  for info in list {
    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    let owner = info[kCGWindowOwnerName as String] as? String ?? ""
    guard layer <= desktopLevel, ["Wallpaper", "Dock", "Finder"].contains(owner), let r = bounds(info) else { continue }
    for i in screens.indices where screens[i].bounds.intersects(r) { screens[i].desktop = true }
  }
  var out: [Win] = []
  for info in list {
    if out.count >= 40 { break }
    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    if layer < 0 || layer >= 20 { continue } // the desktop, the Dock, the menu bar, menus, Capri's own overlay (screen saver level)
    let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
    if alpha < 0.05 { continue }
    let owner = info[kCGWindowOwnerName as String] as? String ?? ""
    if owner == "Window Server" || owner == "Dock" { continue }
    guard let rect = bounds(info), rect.width >= 200, rect.height >= 120 else { continue }
    let id = info[kCGWindowNumber as String] as? Int ?? 0
    let pid = pid_t(info[kCGWindowOwnerPID as String] as? Int ?? 0)
    out.append(Win(id: id, pid: pid, owner: owner, rect: rect, layer: layer, fs: layer == 0 && fullScreen(rect, screens)))
  }
  return out
}

var frontApp: NSRunningApplication? = NSWorkspace.shared.frontmostApplication
var lastWins = ""
var lastApp = "" // what was said last about the app in front
var pendingApp = "" // what the app in front looks like now: said once it holds for two looks
var pendingSince = 0

func look() {
  let wins = windows()
  let front = frontApp
  let frontPid = front?.processIdentifier ?? 0
  // the window in front: the app in front's first normal window
  let fg = wins.first { $0.pid == frontPid && $0.layer == 0 } ?? wins.first { $0.pid == frontPid }

  let snap: [String: Any] = [
    "t": "wins",
    "fg": fg?.id ?? 0,
    "taskbar": false,
    "wins": wins.map { w in
      [
        "id": w.id, "x": Int(w.rect.minX), "y": Int(w.rect.minY), "w": Int(w.rect.width), "h": Int(w.rect.height),
        "fs": w.fs, "pid": Int(w.pid), "owner": w.owner,
      ] as [String: Any]
    },
  ]
  if let data = try? JSONSerialization.data(withJSONObject: snap, options: [.sortedKeys]),
     let line = String(data: data, encoding: .utf8), line != lastWins {
    lastWins = line
    print(line)
  }

  // The app in front, and whether it's full screen. A Space sliding in takes a moment: only
  // once it has looked the same twice in a row.
  guard let app = front else { return }
  let fullscreen = fg?.fs ?? false
  let key = "\(app.processIdentifier)|\(fullscreen)"
  if key != pendingApp {
    pendingApp = key
    pendingSince = 0
    return
  }
  pendingSince += 1
  if pendingSince >= 2 && key != lastApp {
    lastApp = key
    emit([
      "t": "app",
      "name": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? "",
      "pid": Int(app.processIdentifier),
      "fullscreen": fullscreen,
    ])
  }
}

let center = NSWorkspace.shared.notificationCenter
center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  if app.processIdentifier == parentPid { return } // clicking Capri herself: you're still on what you were on
  frontApp = app
  look()
}
center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
  emit(["t": "space"])
  look()
}

center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
  guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  emit(["t": "quit", "name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? ""])
}
center.addObserver(forName: NSWorkspace.didMountNotification, object: nil, queue: .main) { note in
  guard let url = note.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL else { return }
  // a disk image being opened (an installer) isn't a device
  if let values = try? url.resourceValues(forKeys: [.volumeIsInternalKey, .volumeIsLocalKey]),
     values.volumeIsInternal == true { return }
  var stat = statfs()
  if statfs(url.path, &stat) == 0 {
    let from = withUnsafePointer(to: &stat.f_mntfromname) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) } }
    if let disk = from.split(separator: "/").last, isDiskImage(String(disk)) { return }
  }
  let name = note.userInfo?[NSWorkspace.localizedVolumeNameUserInfoKey] as? String ?? url.lastPathComponent
  emit(["t": "mount", "name": name, "path": url.path])
}

// Whether a disk (disk4s1) is a disk image: its IOKit parent chain goes through the disk image driver.
func isDiskImage(_ bsd: String) -> Bool {
  guard let match = IOBSDNameMatching(kIOMainPortDefault, 0, bsd) else { return false }
  var service = IOServiceGetMatchingService(kIOMainPortDefault, match)
  var depth = 0
  while service != 0 && depth < 12 {
    if let cls = IOObjectCopyClass(service)?.takeRetainedValue() as String?, cls.contains("DiskImage") {
      IOObjectRelease(service)
      return true
    }
    var parent: io_registry_entry_t = 0
    let found = IORegistryEntryGetParentEntry(service, kIOServicePlane, &parent) == KERN_SUCCESS
    IOObjectRelease(service)
    service = found ? parent : 0
    depth += 1
  }
  if service != 0 { IOObjectRelease(service) }
  return false
}

// USB devices plugged in: an IOKit notification (the ones there already at start are skipped).
let usbPort = IONotificationPortCreate(kIOMainPortDefault)
var usbIterator: io_iterator_t = 0
func drainUsb(_ iterator: io_iterator_t, report: Bool) {
  while case let device = IOIteratorNext(iterator), device != 0 {
    if report {
      var name = [CChar](repeating: 0, count: 128)
      IORegistryEntryGetName(device, &name)
      emit(["t": "usb", "name": String(cString: name)])
    }
    IOObjectRelease(device)
  }
}
if let usbPort {
  CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(usbPort).takeUnretainedValue(), .defaultMode)
  let added = IOServiceAddMatchingNotification(usbPort, kIOFirstMatchNotification, IOServiceMatching("IOUSBHostDevice"), { _, iterator in
    drainUsb(iterator, report: true)
  }, nil, &usbIterator)
  if added == KERN_SUCCESS { drainUsb(usbIterator, report: false) }
}

Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in look() }
// stop with Capri, even if she crashed without telling us
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
  if getppid() == 1 || (parentPid > 0 && kill(parentPid, 0) != 0) { exit(0) }
}
// or when her end of the pipe closes
FileHandle.standardInput.readabilityHandler = { handle in
  if handle.availableData.isEmpty { exit(0) }
}

if frontApp?.processIdentifier == parentPid { frontApp = nil }
look()
RunLoop.main.run()
