# Apex Arcade

A complete, buildless 3D arcade time-attack game using vanilla ES modules, Three.js 0.170.0, and Cannon-es 0.20.0. The included orange Darsche 91 R and Qatar circuit were converted from your local `MODELS` archives. No asset conversion or JavaScript build is needed to play or publish this folder.

## Play locally

1. Open a terminal **inside this folder**, beside `index.html`.
2. Run either:

   ```sh
   npx --yes serve .
   ```

   Or, with Python installed:

   ```sh
   python3 -m http.server 8080
   ```

3. Open the HTTP URL printed by the server, such as `http://localhost:3000` or `http://localhost:8080`.
4. Wait for the car and circuit to load, then select **LET’S DRIVE**.

VS Code Live Server also works: open this folder in VS Code, right-click `index.html`, and select **Open with Live Server**. Do not open the HTML file using `file://`; browsers restrict model fetching and module imports there. An internet connection is required for the pinned CDN modules and optional Google Fonts. If fonts are blocked, local fallback fonts are used.

## Controls

| Input | Action |
| --- | --- |
| W / Up | Accelerate |
| S / Down | Brake, then reverse |
| A / Left | Steer left |
| D / Right | Steer right |
| Space | Handbrake / drift |
| R / Respawn button | Recover at the last checkpoint |
| Escape / Pause button | Pause or resume |
| Gamepad-shaped HUD button | Show or hide touch controls |
| Music-note HUD button | Enable or mute synthesized engine audio |

Touch controls support simultaneous steering and throttle using separate fingers. They automatically appear on devices with coarse pointers. The optional audio starts only after a user gesture. Switching tabs or leaving the window pauses the game and releases held inputs.

## Time attack rules

- Drive through the orange checkpoint markers in order. The minimap shows your position.
- Complete the 3.47 km circuit in the forward direction to record a lap.
- Your fastest valid lap is saved in this browser using `localStorage`.
- Spending more than 1.5 seconds off asphalt or respawning marks the current lap **UNRANKED**. Cross the finish line to begin a fresh valid lap.
- Pausing freezes physics and the lap clock. Restarting from the pause menu returns to the grid and clears the current run, while preserving your personal best.
- There is no lap limit. This is a solo time attack; no opponents or multiplayer service is required.

## Publish on GitHub Pages

1. Create a GitHub repository, for example `apex-arcade`. A public repository works with GitHub Free.
2. Upload the **contents of this folder** to the repository root. `index.html`, `styles.css`, `js/`, and `assets/` must be beside one another at the root. Upload the extracted project, not just its ZIP archive. Preserve the `.nojekyll` file.
3. Commit the files to the `main` branch. You can use GitHub’s **Add file → Upload files**, GitHub Desktop, or Git:

   ```sh
   git init
   git add .
   git commit -m "Add Apex Arcade racing game"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/apex-arcade.git
   git push -u origin main
   ```

   Use these commands only in a new project folder. If you already have a repository, copy the game into its publishing root and commit normally.

4. In the repository, open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Choose branch **main**, folder **/(root)**, and click **Save**.
7. Wait for the Pages deployment to finish. GitHub shows the resulting link in Settings → Pages. For a project repository it usually looks like `https://YOUR-USERNAME.github.io/apex-arcade/`.
8. Open the link and start a lap. Subsequent pushes to `main` update the site automatically.

The app uses relative URLs and `new URL(..., import.meta.url)` for assets, so repository subfolder URLs work without changing a base path. There is no API key, server, bundler, or environment variable to configure. GitHub’s current publishing instructions: [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## File-by-file setup

```text
apex-arcade/
├── index.html                 # Import map, loading screen, HUD, menus, touch buttons
├── styles.css                 # Responsive game interface and mobile layouts
├── js/
│   ├── main.js                # Initialization, render loop, lighting, chase camera, UI
│   ├── car.js                 # Cannon chassis, suspension, grip, steering, input
│   ├── track.js               # GLTFLoader, transformed collision meshes, start line, map
│   ├── wheels.js              # Independent steering pivots and axle-centered rolling
│   ├── race.js                # Ordered checkpoint gates, lap validation and formatting
│   └── audio.js               # Optional Web Audio engine synthesis
├── assets/
│   ├── car/car.glb            # Self-contained car with separate wheel meshes
│   ├── car/car-info.json      # Dimensions and conversion metadata
│   ├── track/track.glb        # Optimized circuit, terrain, curbs, and scenery
│   ├── track/route.json       # Circuit centerline, road width, spawn, measured length
│   ├── track/ASSET-NOTES.md   # Track conversion provenance
│   ├── licenses/              # Asset provenance and source notes
│   └── favicon.svg
├── tests/
│   ├── race.test.js           # Lap and checkpoint rules
│   └── physics.test.js        # Driving, imported collisions, and optimization checks
├── package.json              # Optional start/test convenience scripts
├── .nojekyll                 # GitHub Pages static hosting marker
└── README.md
```

## Implementation details

- **Rendering:** antialiasing, capped device pixel ratio, sRGB output, ACES tone mapping, soft PCF shadows, ambient/hemisphere lighting, directional sun, distance fog, and a matching sky background. Shadow coverage follows the player.
- **Physics:** a dynamic Cannon chassis with four raycast spring/damper suspension probes, physical collision supports, longitudinal force, speed-dependent steering, lateral grip, braking/reverse gating, handbrake grip reduction, and gravity. The physics step is fixed at 60 Hz and render transforms interpolate between steps. Control forces are disabled in the air.
- **Track collisions:** world-transformed GLB triangles become static Cannon trimeshes. Spatial chunks keep collision bounds tight and remain below Cannon’s signed 16-bit vertex-index limit. A broadphase tailored to a static circuit checks moving bodies against scenery without scanning static/static pairs. Per-shape octree queries prune missed branches, addressing a performance issue in the pinned Cannon-es version. Roads, terrain, and barriers use collision group 1; the car uses group 2. Suspension probes exclude the car itself.
- **Camera:** exponential damping via `Vector3.lerp` smooths both the car’s heading and the chase position/look target. Field of view opens slightly with speed.
- **Timing:** forward plane crossings, gate width and height tests, ordered checkpoints, off-track detection, and reset invalidation stop start-line oscillation or teleporting from generating a valid best lap. Finish time interpolates within the simulation step.
- **Resilience:** loading progress, an actionable loading failure screen, retry, WebGL context-loss feedback, safe storage access, input cleanup, pause focus handling, and font fallbacks.

## Tuning and replacing models

Driving constants live near the top of `js/car.js`. `MAX_FORWARD_SPEED`, drive acceleration, suspension force, lateral grip, and the steering curve can be adjusted there. World gravity is configured in `js/main.js`.

To replace the car, export a self-contained GLB at `assets/car/car.glb`, Y-up and +Z-forward, centered in X/Z with its tire bottoms at Y=0. The included car is 4.60 m long. The visual is placed 0.56 m below the chassis origin to match the suspension. Steering is relative to the driver: with +Z forward and +Y up, right is local -X. Independent Y steering pivots and X rolling rotations keep the wheel axles level. Front/rear wheel nodes named `wheel_front_left`, `wheel_front_right`, `wheel_rear_left`, and `wheel_rear_right` rotate around local X. Recheck body dimensions and wheel probes when using a substantially different vehicle.

To replace the track, export `assets/track/track.glb` and edit `assets/track/route.json`. Use meter units, Y-up, and the same world coordinates in both files. Name the driveable mesh `Road`, terrain `Terrain`, and barriers with `Barrier` in the name; alternatively set node `extras.collidable: true`. Provide ordered centerline points as `[x,y,z]`, without repeating the first point at the end, plus `name`, `length`, `roadWidth`, and a spawn object `{position:{x,y,z},heading}`. Heading is yaw in radians with 0 facing +Z. Place the chassis about 0.8 m above the road at spawn. Keep triangles reasonably sized for collision performance. This loader expects ordinary GLB geometry; Draco/KTX decoders are not configured.

## Verification

With Node.js 18 or newer:

```sh
npm install
npm test
```

The optional test dependencies are pinned Three.js and Cannon-es packages; the game itself does not need npm. For the lap rules alone, `npm run test:race` needs no installation. Test browser layouts in portrait and landscape, exercise acceleration/brake/reverse, steering and Space, drive into a perimeter barrier, respawn, pause/resume, and complete the circuit before publishing any customized physics or replacement asset.

The delivered version passes 43 automated tests, including the actual included road and barrier GLB geometry. Browser checks covered loading, touch acceleration, checkpoint advancement, pause, and responsive layouts from 320 to 1440 pixels. No browser console errors were observed during those checks. Device performance varies; a complete manual timed lap on every target device was not part of this verification.

## Asset notes

The original ZIPs contain OBJ geometry with references to missing MTL files. The included GLBs preserve selected source geometry with reconstructed cartoon materials and reduced geometry for browser delivery. The track export’s missing fence transparency is reconstructed as an open wireframe safety mesh. Model conversion notes are included under `assets/`.

The supplied archives did not include an asset license. Keep your original purchase/license records and attribution requirements with any public distribution. Three.js and Cannon-es retain their upstream MIT licenses; this project loads their pinned distributions from jsDelivr. Nothing in this project grants additional rights to the supplied car or circuit artwork.

## Troubleshooting

- **Blank page or CDN error:** use an HTTP server and check that jsDelivr is reachable. The loading screen offers retry if the modules or models fail.
- **404 on GitHub Pages:** confirm `index.html` is at the selected publishing root and all lowercase `assets/` and `js/` paths were uploaded with their exact names.
- **Missing car or circuit:** include the two GLB files and `route.json`; copying only the five code files omits the game assets.
- **Low frame rate:** close other GPU-heavy tabs, reduce the browser size, or lower the pixel-ratio cap and shadow-map resolution in `js/main.js`.
- **Best time not remembered:** storage may be disabled in private browsing. The game still works and keeps the best for the current session.
- **Mobile input sticks:** lift the pointer, pause/resume, or respawn. Pointer cancellation, blur, and pause all clear controls.
