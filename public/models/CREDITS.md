# Aircraft model credits

The three aircraft in this folder, and their cockpits (the `_pit` files), come from
[FlightGear](https://www.flightgear.org), the free flight simulator, and keep its license: the **GNU General Public
License, version 2** (the F-16: version 2 or any later version).
The full text is in [`GPL-2.0.txt`](GPL-2.0.txt). These files are the FlightGear models converted to binary glTF;
they may be copied, changed and passed on under that license, and anyone who passes them on must pass on the same
freedoms. The source of each (the `.ac` model files, their textures and the model `.xml` files that place the parts
and hold the hinges) is at the address in the table, and the conversion is `tools/ac2glb.py` in this repository, so
the files can be rebuilt and changed.

The Cessnas are not in this folder: they are generated in code (`src/aircraft/model.js`).

| File | Aircraft | Source | Authors | License |
|---|---|---|---|---|
| `f16.glb` | General Dynamics F-16 | [NikolaiVChr/f16](https://github.com/NikolaiVChr/f16), `Models/f16.ac`, `f16.png`, `f16trans.png`, `Effects/glass/canopy2.png`, `F-16.xml` | Erik Hofman (main author), Nikolai V. Chr., J Maverick 16, Jonathan Redpath, Richard Harrison and the others in that repository's `authors.txt` | GPL 2.0 or later (`copyright.txt` there) |
| `b738.glb` | Boeing 737-800 | [FGMEMBERS/737-800](https://github.com/FGMEMBERS/737-800), `Models/737-800.ac`, `LWing.ac`, `RWing.ac`, `HorzStab.ac`, `VertStab.ac`, `nosegear.ac`, `winglet.ac`, `737-800.png` and their `.xml` files | The FlightGear 737-800 authors (the repository names none; its history is the record) | GPL 2.0 (`LICENSE` there) |
| `p51d.glb` | North American P-51D Mustang | [FGMEMBERS/p51d](https://github.com/FGMEMBERS/p51d), `Models/P-51D-25NA.ac`, `Cockpit/canopy.ac`, `prop.ac`, `propDisk.ac`, their textures and `p51d-jw-jsbsim.xml` | Jim Wilson (the original, about 2003), Hal V. Engel (the detailed model, 2010 to 2014), and the others in `p51d-contributors.txt` there | GPL 2.0: the aircraft was part of FlightGear's own data, which is under that license; the repository itself carries no license file |

### The cockpits

| File | Cockpit of | Source | Authors | License |
|---|---|---|---|---|
| `f16_pit.glb` | F-16 (as the Block 50 of that repository) | [NikolaiVChr/f16](https://github.com/NikolaiVChr/f16): `Models/Cockpit/Main/cockpit.xml` and everything it includes for that variant, from `Models/Cockpit/` (`Main/`, `Panels/`, `Instruments/`, `Avionics/`, `chair/`, `Textures/`, the throttle, pedals and head-up display frame), one texture of `Models/Pilots/`; the altimeter of FlightGear's shared instruments (below) | As that repository's `authors.txt` credits the cockpit: Martin "Pegasus" Schmitt and Prohm "Rama" Snitwong (cockpit textures and layout), Nikolai V. Chr. (changes to MFD, HUD, 3D cockpit), J Maverick 16 (3D work, panel layouts), Jonathan Redpath (cockpit work), Richard Harrison (HUD, MFDs, 3D misc. panel), NC-687 and Adam Barszczak (side stick), PH-JAKE (Block 50 left panel), with Erik Hofman the aircraft's main author and the others listed there | GPL 2.0 or later (`copyright.txt` there) |
| `b738_pit.glb` | Boeing 737-800 | [FGMEMBERS/737-800](https://github.com/FGMEMBERS/737-800): `Models/cockpit.xml` and what it includes (`cockpit.ac`, `flightdesk.ac`, `pedestal.ac`, `oh-panel.ac`, `pedals.ac`, `Models/Instruments/`: the display units, standby instruments, clocks, autopilot and EFIS panels, their textures); the control display units of FlightGear's shared instruments (below) | The FlightGear 737-800 authors (the repository names none; its history is the record) | GPL 2.0 (`LICENSE` there) |
| `p51d_pit.glb` | P-51D Mustang | [FGMEMBERS/p51d](https://github.com/FGMEMBERS/p51d): `Models/Instruments/Instruments.xml`, `Models/Cockpit/CockpitDevices.xml`, `Models/Cockpit/cockpit.xml` and what they include (`Models/Cockpit/`, `Models/Instruments/`); the K-14 gunsight, A-14A oxygen regulator, AN/APS-13 and SCR-522C boxes of FlightGear's shared instruments (below) | Jim Wilson (the original, about 2003: the instruments bear his initials), Hal V. Engel (the detailed cockpit, 2010 to 2014), and the others in `p51d-contributors.txt` there | GPL 2.0: the aircraft was part of FlightGear's own data, which is under that license; the repository itself carries no license file |
| (in the three above) | Shared instruments | FlightGear's data, [flightgear/fgdata](https://gitlab.com/flightgear/fgdata), `Aircraft/Instruments-3d/`: `altimeter/`, `cdu2/`, `computing-gun-sights/K14/`, `A-14A-OxReg/`, `AN-APS-13/`, `SCR-522C/` | The FlightGear contributors (these files name no author) | GPL 2.0 (`LICENSE.md` there) |

What is on the screens of the 737 and the F-16, and the symbols of the F-16's head-up display, is not from
FlightGear: the game draws them itself (`src/aircraft/displays.js`).

## How they were made

Each is one run of `tools/ac2glb.py`, from a folder holding the files named above:

```bash
python3 tools/ac2glb.py public/models/f16.glb f16.ac --drop '^(Afetrburner|Logos|Chute|RNLAF_Tailroot|FanRHighSpeed.*|FanSpinning|LWStation.|RWStation.)$' --rig F-16.xml --drive 'generic/float\[6\]$=flapR' --drive 'generic/float\[5\]$=flapL' --drive 'generic/float\[4\]$=elevR*0.4363' --drive 'elevator-pos-norm$=elevL*0.4363'
```

```bash
python3 tools/ac2glb.py public/models/b738.glb 737-800.ac LWing.ac RWing.ac HorzStab.ac VertStab.ac nosegear.ac winglet.ac --rig NoseGear.xml --rig LWing.xml --rig RWing.xml --rig HorzStab.xml --rig VertStab.xml --drive 'spoilers-(23|45)-pos$=brake*40'
```

```bash
python3 tools/ac2glb.py public/models/p51d.glb P-51D-25NA.ac canopy.ac prop.ac propDisk.ac --texture '..\..\Models\propDiskSpinner.png=propDiskSpinner.png' --rig p51d-jw-jsbsim.xml --drop '^(guns|spinner2)$'
```

The cockpits, from a folder holding the repositories' files under `f16/`, `737-800/`, `p51d/` and `fgdata/` as they
lie in each (only the files named above are needed; the pilot figures, kneeboards and landing-light cones that the
model files also name are not, and are passed over):

```bash
python3 tools/ac2glb.py public/models/f16_pit.glb --model f16/Models/Cockpit/Main/cockpit.xml --aircraft f16=f16 --aircraft Instruments-3d=fgdata/Aircraft/Instruments-3d --prop sim/variant-id=5 --prop 'sim/multiplay/generic/int[9]=5' --prop f16/avionics/hud-basic=0 --prop controls/test/test-panel/mal-ind-lts=0 --prop sim/current-view/internal=1 --prop f16/ejected=0 --false 'f16/avionics/caution/|f16/fcs/(stby|adv)-mode|ecm-enabled|instrumentation/tfs/|lighting/ar-nws|tmp/nill' --texture-size 'Tex_0004_1=256' --texture-size 'marked-iron|base-color|floor|stick-color2|eject-handle=512' --atlas 2048 --max-texture 1024 --vertex-colors --compact --webp 90
```

```bash
python3 tools/ac2glb.py public/models/b738_pit.glb --model 737-800/Models/cockpit.xml --aircraft 737-800=737-800 --aircraft Instruments-3d=fgdata/Aircraft/Instruments-3d --atlas 2048 --max-texture 1024 --vertex-colors --compact --webp 90
```

```bash
python3 tools/ac2glb.py public/models/p51d_pit.glb --model p51d/Models/Instruments/Instruments.xml --model p51d/Models/Cockpit/CockpitDevices.xml --model p51d/Models/Cockpit/cockpit.xml --aircraft p51d=p51d --aircraft Instruments-3d=fgdata/Aircraft/Instruments-3d --texture-size 'A-14A|BC-602-A|SCR-695|K-14A|gun-circuit|throttle=512' --texture-size 'boot|pedels|landing-gear-lever|trimknob|reset=256' --atlas 2048 --max-texture 1024 --vertex-colors --compact --webp 90
```

(Add `--files` to any of them for the list of every file that went in.)

What the conversion changes in a cockpit: every sub-model is put where its model file places it, in the game's axes
and about the same origin as the outside of the aircraft; the parts' colors go into their vertices and their textures
onto a few shared sheets, scaled down (to 1024 pixels at most, the lesser ones to 512 or 256) and stored as WebP;
what the chosen variant hides is left out (the F-16 is built as its Block 50, with its warning lights out); the
hinges of needles, drums, controls and flags are read from the model files and stored in the file, named for what
the game drives them with. The canopies and windows are those of the outside models. What the game adds at run
time (the pictures on the screens, the head-up display, a pitch movement for the P-51's horizon bar, panel lighting
at night) is in `src/aircraft/pit.js` and `displays.js`.

What the conversion changes in the outside models: the parts are put in the game's axes and merged into one file with their textures;
normals are smoothed as AC3D does; a few objects are left out (the F-16's modeled afterburner flame, drag chute,
squadron markings and weapon pylons; the P-51's gun ports and its second, blurred spinner); the hinges of the
landing gear and control surfaces are read from the model `.xml` files and stored in the file. Nothing is repainted:
the liveries are the plain ones the models come with. What the game adds at run time (lights, the F-16's nozzle and
afterburner flame, contrails) is in `src/aircraft/gltfmodel.js`.
