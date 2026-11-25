package dev.dropit.app

import android.app.Application
import dev.dropit.app.di.AppContainer
import dev.dropit.app.di.DefaultAppContainer

class DropitApplication : Application() {
    val container: AppContainer by lazy { DefaultAppContainer(this) }
}
