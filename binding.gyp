{
  "conditions": [
    ["OS=='mac'", {
      "targets": [
        {
          "target_name": "ax_helper",
          "sources": ["native/ax-helper.mm"],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
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
        }
      ]
    }]
  ]
}
