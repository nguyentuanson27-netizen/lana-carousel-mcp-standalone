# Video Analysis content brief workflow

## Required conversation brief

Before `create_video_analysis_project`, ChatGPT must collect the three required fields in one consolidated question when they are missing:

- `content_domain`: `fashion`, `beauty`, `entertainment`, `food`, `travel`, `technology`, `education`, `business`, `lifestyle`, `other`.
- `tone_style`: `humorous`, `witty`, `friendly`, `energetic`, `trendy`, `luxurious`, `serious`, `expert`, `emotional`, `storytelling`, `persuasive_sales`, `minimal`.
- `tts_speed`: `0.8`, `1`, `1.2`, `1.5`, `1.8`, `2`.

`content_goal` is optional: `product_showcase`, `sales`, `review`, `tutorial`, `storytelling`, `entertainment`, `brand_awareness`, `engagement`, `other`.

The speed changes voice playback only. Source video playback speed and segment timestamps remain unchanged.

Example user reply:

```text
Thời trang – Hài hước – x1.2 – Giới thiệu sản phẩm
```

## Two-option script flow

1. Analyze scenes and preserve source timestamps.
2. Generate exactly two structurally different options:
   - `natural_full`: complete natural sentences, target 80–90% of the safe word budget.
   - `punchy_short`: short rhythmic lines, target 55–70% of the safe word budget.
3. Call `prepare_video_script_options` with at least one segment per option. Both options must use the same ordered segment IDs and timestamps.
4. The server validates the options, persists their exact content and returns `prepared_options_id` plus a SHA-256 content hash.
5. Show both options and timeline-fit warnings to the user, then wait for an explicit selection.
6. Call `save_approved_video_script` with only `prepared_options_id` and `selected_option`. The server loads the exact persisted segments; callers cannot resend or alter them.

A prepared set becomes invalid if the project version, content brief or source video changes. It is cleared after a successful save.

## Option integrity rules

- Neither option may be empty.
- Every segment must have a stable ID, valid timestamps, subtitle text and voice-over text.
- Both options must have the same ordered IDs and timestamps.
- `punchy_short` must be shorter than `natural_full` and differ in at least half of the segments.
- Server-managed settings (`analysisBrief`, `selectedScriptOption`, `preparedScriptOptions`) are never accepted from caller settings.

## Word budget

```text
maximum words = segment duration × 2.5 words/second × TTS speed × 0.85
```

The 0.85 safety factor leaves room for punctuation, pauses and Vietnamese pronunciation variance.

## TTS speed ownership

The selected speed is stored in `settings.analysisBrief.ttsSpeed` and copied to `settings.ttsSpeed` when a selected script is saved. Vertex receives the requested delivery style but not a second pace instruction; Remotion applies the speed once through audio playback rate.
