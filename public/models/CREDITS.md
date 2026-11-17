# Aircraft model credits

The three aircraft in this folder come from [FlightGear](https://www.flightgear.org), the free flight simulator, and
keep its license: the **GNU General Public License, version 2** (the F-16: version 2 or any later version). The
full text is in [`GPL-2.0.txt`](GPL-2.0.txt). These files are the FlightGear models converted to binary glTF; they
may be copied, changed and passed on under that license, and anyone who passes them on must pass on the same
freedoms. The source of each (the `.ac` model files, their textures and the model `.xml` files that hold the
hinges) is at the address in the table, and the conversion is `tools/ac2glb.py` in this repository, so the files can
be rebuilt and changed.

The Cessnas are not in this folder: they are generated in code (`src/aircraft/model.js`).

| File | Aircraft | Source | Authors | License |
|---|---|---|---|---|
| `f16.glb` | General Dynamics F-16 | [NikolaiVChr/f16](https://github.com/NikolaiVChr/f16), `Models/f16.ac`, `f16.png`, `f16trans.png`, `Effects/glass/canopy2.png`, `F-16.xml` | Erik Hofman (main author), Nikolai V. Chr., J Maverick 16, Jonathan Redpath, Richard Harrison and the others in that repository's `authors.txt` | GPL 2.0 or later (`copyright.txt` there) |
| `b738.glb` | Boeing 737-800 | [FGMEMBERS/737-800](https://github.com/FGMEMBERS/737-800), `Models/737-800.ac`, `LWing.ac`, `RWing.ac`, `HorzStab.ac`, `VertStab.ac`, `nosegear.ac`, `winglet.ac`, `737-800.png` and their `.xml` files | The FlightGear 737-800 authors (the repository names none; its history is the record) | GPL 2.0 (`LICENSE` there) |
| `p51d.glb` | North American P-51D Mustang | [FGMEMBERS/p51d](https://github.com/FGMEMBERS/p51d), `Models/P-51D-25NA.ac`, `Cockpit/canopy.ac`, `prop.ac`, `propDisk.ac`, their textures and `p51d-jw-jsbsim.xml` | Jim Wilson (the original, about 2003), Hal V. Engel (the detailed model, 2010 to 2014), and the others in `p51d-contributors.txt` there | GPL 2.0: the aircraft was part of FlightGear's own data, which is under that license; the repository itself carries no license file |

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

What the conversion changes: the parts are put in the game's axes and merged into one file with their textures;
normals are smoothed as AC3D does; a few objects are left out (the F-16's modeled afterburner flame, drag chute,
squadron markings and weapon pylons; the P-51's gun ports and its second, blurred spinner); the hinges of the
landing gear and control surfaces are read from the model `.xml` files and stored in the file. Nothing is repainted:
the liveries are the plain ones the models come with. What the game adds at run time (lights, the F-16's nozzle and
afterburner flame, contrails) is in `src/aircraft/gltfmodel.js`.
