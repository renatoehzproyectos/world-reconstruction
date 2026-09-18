# Street View Grounding

Do NOT spend time porting unrelated code, changing the project architecture, or editing the building editor. Focus specifically on implementing the Street View spawn + API key features I requested.



1. Reconstruct must spawn the player on the ground



When I press Reconstruct:



- Do NOT spawn me in a drone/flying/free camera position.

- Do NOT leave the player floating above the terrain.

- The player/vehicle must spawn at ground level.

- The spawn point must be directly on or immediately beside a nearby drivable street/road.

- Prefer the closest valid road to the reconstructed location.

- The initial player position should make sense for a driving simulation.

- The player should be oriented along the road, not randomly rotated.

- The camera should start in the normal player/vehicle view, not a bird's-eye/drone view.



2. Use the same road/location context as Street View



The application already uses Street View on the other side of the screen. Street View represents a road-level viewpoint, so the reconstructed 3D world should behave consistently with that.



After reconstruction:



1. Determine the reconstruction's geographic location.

2. Find the nearest usable road.

3. Determine the road's position/elevation.

4. Place the player on that road at ground height.

5. Orient the player according to the road direction.

6. Then enter the normal driving/player mode.



Do not invent a random spawn point.



3. Add Street View API Key configuration



Add a clearly visible configuration/settings section called:



Street View API Key



It must contain:



- A password-style/API-key "<input>".

- The entered key must be hidden by default.

- A show/hide control is optional but recommended.

- A Save button.



Example UX:



Street View API Key

[ •••••••••••••••••••• ] [Show]

[ Save ]



When Save is pressed:



- Save the API key persistently using the browser's local storage or the project's existing persistence mechanism.

- Do NOT require me to enter the key again after refreshing the page.

- Load the saved key automatically when the application starts.

- Use the saved key automatically for Street View requests.

- Never display the complete saved key elsewhere in the UI.

- Do not put the key into source code, hardcoded constants, or the repository.



4. Existing key handling



Before adding a new storage system, inspect the existing project for any Street View API-key/configuration logic.



If one already exists, reuse it rather than creating duplicate state.



The API key input should be connected to the actual Street View implementation, not just be a cosmetic textbox.



5. Reconstruct behavior



The final flow should be:



Select/location → Reconstruct → generate/load 3D environment → find nearest road → place player on road at correct ground elevation → orient player along road → enter normal player/vehicle mode



The Street View panel should remain a road-level reference on the other side of the screen.



6. Important technical requirements



- Reuse the existing map/road/geographic data already present in the project.

- Do not replace the existing 3D engine unless absolutely necessary.

- Do not break the existing reconstruction/building editing functionality.

- Avoid expensive continuous terrain-height queries every frame.

- Grounding only needs to happen when calculating the spawn position, not continuously.

- Add proper null/error handling if no road can be found.

- If no road is available at the exact reconstruction coordinate, search outward for the nearest road within a reasonable radius and use that.

- Make the implementation actually work in the current project rather than leaving TODOs/placeholders.



7. Verify before finishing



After implementing it, check the actual Reconstruct button handler and trace the complete flow to confirm:



- Reconstruct really calls the new spawn logic.

- The player is actually moved to the calculated road position.

- The player is actually placed at ground height.

- The player is actually rotated to the road direction.

- The Street View API key is actually persisted and restored.

- The saved API key is actually used by Street View.

- TypeScript/build errors are fixed.



Do not just tell me that this is implemented. Inspect the relevant files, make the changes, and verify the complete flow.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/1d25d3ca-c0ba-4145-abf7-b18e5a7db245).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
