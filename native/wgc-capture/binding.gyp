{
  "targets": [
    {
      "target_name": "wgc_capture",
      "sources": [
        "src/addon.cpp",
        "src/capture_engine.cpp",
        "src/cursor_sampler.cpp",
        "src/video_encoder.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "cflags_cc": ["-std:c++17"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          },
          "libraries": [
            "windowsapp.lib",
            "d3d11.lib",
            "dxgi.lib",
            "dwmapi.lib",
            "mfplat.lib",
            "mfreadwrite.lib",
            "mfuuid.lib"
          ]
        }]
      ]
    }
  ]
}
