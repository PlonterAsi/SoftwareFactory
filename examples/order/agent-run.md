# Order Engine run

11 signals → 16 fragments, 4 nodes, 2 conflicts. Mode: agent. Archivist cost: $0.0095. Time: 82 s.

## Tree, with every fragment where it was filed

- **project: Garden Planner**
  - note (90%, signal #1): a garden planner app
  - rule ★ (90%, signal #1): it must work offline
  - decision ★ (85%, signal #35): We decided to store everything in SQLite on the device.
  - rule ★ (80%, signal #82): The garden planner may need the network for weather, so it must not work offline only.
  - **idea: Weather-based watering advice**
    - idea (60%, signal #1): maybe it tells you when to water based on the weather
    - note (55%, signal #13): my tomatoes died again
    - idea (70%, signal #59): watering reminders could also use soil moisture sensors
  - **idea: Plant photo timelapse log**
    - idea (90%, signal #20): a plant photo log where you snap a picture every week and it makes a timelapse
    - ~~rule~~ ★ (90%, signal #28): For the photo log, photos must never leave the phone.
    - decision ★ (90%, signal #73): Actually the photo log should upload photos to the cloud so they sync across devices.
- **project: Recipe Box**
  - note (90%, signal #42): Project: Recipe Box
  - note (80%, signal #42): A recipe box that scales ingredients for the number of guests.
  - idea (80%, signal #51): Recipes should be shareable with a link.
  - question (90%, signal #51): what about importing recipes from websites?

## Unsorted tray (0)


## Hidden as noise (2)

- ok
- thanks!

## Canon per node

**Garden Planner**
- The garden planner may need the network for weather, so it must not work offline only. _(signal #82: "The garden planner may need the network for weather, so it m…")_
- We decided to store everything in SQLite on the device. _(signal #35: "We decided to store everything in SQLite on the device.…")_
- it must work offline _(signal #1: "Project: Garden Planner ok so a garden planner app. maybe it…")_

**Plant photo timelapse log**
- Actually the photo log should upload photos to the cloud so they sync across devices. _(signal #73: "Actually the photo log should upload photos to the cloud so …")_

## Conflicts

- **resolved by newer-over-older**: "For the photo log, photos must never leave the phone." vs "Actually the photo log should upload photos to the cloud so they sync across devices.". The Archivist says these clash. Kept: "Actually the photo log should upload photos to the cloud so they sync across devices.".
- **open**: "it must work offline" vs "The garden planner may need the network for weather, so it must not work offline only.". The Archivist says these clash. Proposed: keep "The garden planner may need the network for weather, so it must not work offline only.".

## Briefing

- Conflict needs your call: "it must work offline" vs "The garden planner may need the network for weather, so it must not…"
- Resolved by newer-over-older: kept "Actually the photo log should upload photos to the cloud so they sy…"

## visualizeEverything

12 of 12 checks pass.
