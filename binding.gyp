{
  "targets": [
    {
      "target_name": "ax_helper",
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "conditions": [
        ['OS=="mac"', {
          "sources": ["native/ax-helper.mm"],
          "cflags!": ["-fno-exceptions"],
          "cflags_cc!": ["-fno-exceptions"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_LDFLAGS": [
              "-framework", "Cocoa",
              "-framework", "ApplicationServices",
              "-framework", "CoreGraphics"
            ]
          }
        }],
        ['OS=="win"', {
          "sources": ["native/win-helper.cc"],
          "libraries": ["dwmapi.lib", "user32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/utf-8", "/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}
