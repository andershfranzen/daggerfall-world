# Visual progress

For changes to the website, launcher, or in-game interface, capture the running browser and embed screenshots in the conversation at meaningful milestones. Include a real in-game view when reporting a HUD or world-rendering change. Identify the screen and what is working, and label any mockup explicitly. Keep captures of player-supplied game content out of the public website and source distribution.

Every agent working on this project should share an image with its progress updates and completion report. Save captures in the ignored `progress/screenshots/agents/` directory and embed the image with a caption describing what was exercised. For server work, capture a real client interaction or a relevant test result. Label fixture and test-harness images. Keep credentials and session tokens out of captures.

Embed progress images in the current reply. Sending them as new messages to the active parent thread queues additional turns. Keep local captures in the ignored progress directory.

# Public patch notes

Record meaningful player-facing gameplay changes in the private website project's patch archive when working on a release. Keep sensitive details, tests, one-off exports and internal workflow changes out of the notes.

# Local game server

The integration owner reloads localhost on port 8080 after verifying server changes. The user has authorized graceful reloads while players are online. Preserve the character and account databases, game data, and server configuration, then check the Play page and live map endpoint. Agents exercise their fixtures on separate ports so the shared server can stay available.

# Agent coordination

Use Opus 5.5 with medium effort by default for delegated work. If an Opus agent cannot take or carry out the assignment, use Sol 6.2 with high effort. Give each agent an explicit area of ownership and have the integration owner verify the combined result.
