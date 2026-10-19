# Track asset

`track.glb` is a self-contained browser-ready conversion of the local `Cartoon Race Track Qatar.zip` supplied for this game. The ZIP contains OBJ geometry and a ground-logo PNG but omits the referenced material files. This conversion rebuilds the material palette, removes degenerate triangle-strip connector faces, removes duplicate fence geometry, and instances repeated grandstands.

The source road layout, curbs, markings, terrain, runoff, pit tower, fences, lighting details, and grandstands are retained. The PNG is not required; the converted GLB has no external texture dependencies.

- Coordinates: meters, +Y up; original geometry scaled by 0.04.
- Collision meshes: `Road`, `Terrain`, and `Barrier_Wall`; each also has `extras.collision: true`.
- Road surface at start: approximately 1.034 m above world origin.
- Start travel direction: +X. For the game's +Z-forward car, heading is +π/2.
- `route.json` contains a 3.471 km closed main-circuit centerline, ordered clockwise, with 1,111 samples and no repeated closing point. Its spawn is 6 m behind the start plane and 0.8 m above the road.
- Source object mapping: asphalt `model_0`, white curbs `model_1`–`model_3`, terrain `model_4`, lighting `model_5`, repeated grandstand `model_6`, road markings `model_27`, pit tower `model_35`, runoff `model_37`, fence `model_38`, burgundy curbs `model_39`, barrier wall `model_41`.

The model files retain the provenance and usage rights of the user-supplied source assets.
