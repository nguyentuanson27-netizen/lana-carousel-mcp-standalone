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
3. Call `prepare_video_script_options` to validate both options.
4. Show both options and timeline-fit warnings to the user.
5. Wait for an explicit selection.
6. Call `save_approved_video_script` with `selected_option` and only the selected segments.

## Word budget

```text
maximum words = segment duration × 2.5 words/second × TTS speed × 0.85
```

The 0.85 safety factor leaves room for punctuation, pauses and Vietnamese pronunciation variance.

## TTS speed ownership

The selected speed is stored in `settings.analysisBrief.ttsSpeed` and copied to `settings.ttsSpeed` when a selected script is saved. Vertex receives the requested delivery style but not a second pace instruction; Remotion applies the speed once through audio playback rate.
