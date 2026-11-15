package com.prata.remote.controller

// PRATA Remote — MainActivity Controller (Command 002, Tugas 3)
// Tiga rute: login -> devices -> scanner.
// startDestination mengikuti TokenStore: ada JWT -> langsung devices.
// ViewModel di-hoist di sini agar DevicesViewModel dipakai bersama oleh
// DeviceListScreen dan QrScannerScreen (refresh sesudah pairing sukses).
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.prata.remote.controller.security.AppLock
import com.prata.remote.controller.ui.DeviceListScreen
import com.prata.remote.controller.ui.LockScreen
import com.prata.remote.controller.ui.LoginScreen
import com.prata.remote.controller.ui.PrataTheme
import com.prata.remote.controller.ui.QrScannerScreen
import com.prata.remote.controller.ui.RemoteControlScreen
import com.prata.remote.shared.security.TokenStore

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PrataTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    // FINAL (Bagian 6): kunci aplikasi — bila PIN diatur,
                    // layar kunci tampil sampai PIN/biometrik benar. Flag
                    // diingat di state Compose agar rotasi tidak mengunci
                    // ulang.
                    var unlocked by remember {
                        mutableStateOf(!AppLock.isPinSet(applicationContext))
                    }
                    val biometricAvailable = remember {
                        AppLock.isBiometricEnabled(applicationContext) &&
                            BiometricManager.from(applicationContext)
                                .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
                            BiometricManager.BIOMETRIC_SUCCESS
                    }
                    if (!unlocked) {
                        LockScreen(
                            onPinEntered = { pin ->
                                val ok = AppLock.verifyPin(applicationContext, pin)
                                if (ok) unlocked = true
                                ok
                            },
                            biometricAvailable = biometricAvailable,
                            onBiometricClick = {
                                val prompt = BiometricPrompt(
                                    this,
                                    ContextCompat.getMainExecutor(this),
                                    object : BiometricPrompt.AuthenticationCallback() {
                                        override fun onAuthenticationSucceeded(
                                            result: BiometricPrompt.AuthenticationResult,
                                        ) {
                                            unlocked = true
                                        }
                                    },
                                )
                                prompt.authenticate(
                                    BiometricPrompt.PromptInfo.Builder()
                                        .setTitle("Buka PRATA Remote")
                                        .setSubtitle("Verifikasi biometrik untuk membuka Controller")
                                        .setNegativeButtonText("Batal")
                                        .build(),
                                )
                            },
                        )
                        return@Surface
                    }
                    val navController = rememberNavController()
                    val tokenStore = remember { TokenStore(applicationContext) }
                    val startDestination = if (tokenStore.hasJwt) "devices" else "login"
                    val loginViewModel: LoginViewModel = viewModel()
                    val devicesViewModel: DevicesViewModel = viewModel()
                    val scannerViewModel: ScannerViewModel = viewModel()

                    NavHost(navController = navController, startDestination = startDestination) {
                        composable("login") {
                            LoginScreen(
                                viewModel = loginViewModel,
                                onLoginSuccess = {
                                    navController.navigate("devices") {
                                        popUpTo("login") { inclusive = true }
                                    }
                                },
                                onContinueToDevices = {
                                    navController.navigate("devices") {
                                        popUpTo("login") { inclusive = true }
                                    }
                                },
                            )
                        }
                        composable("devices") {
                            DeviceListScreen(
                                viewModel = devicesViewModel,
                                onScanClick = { navController.navigate("scanner") },
                                onNavigateToLogin = {
                                    navController.navigate("login") {
                                        popUpTo("devices") { inclusive = true }
                                    }
                                },
                                onDeviceClick = { device ->
                                    navController.navigate("remote/${device.id}/${Uri.encode(device.name)}")
                                },
                            )
                        }
                        composable(
                            "remote/{deviceId}/{deviceName}",
                            arguments = listOf(
                                navArgument("deviceId") { type = NavType.StringType },
                                navArgument("deviceName") { type = NavType.StringType },
                            ),
                        ) { backStackEntry ->
                            val deviceId = backStackEntry.arguments?.getString("deviceId") ?: return@composable
                            val deviceName = Uri.decode(
                                backStackEntry.arguments?.getString("deviceName") ?: deviceId,
                            )
                            val remoteViewModel: RemoteControlViewModel = viewModel(
                                factory = RemoteControlViewModelFactory(application, deviceId, deviceName),
                            )
                            RemoteControlScreen(
                                viewModel = remoteViewModel,
                                onBack = { navController.popBackStack() },
                            )
                        }
                        composable("scanner") {
                            QrScannerScreen(
                                viewModel = scannerViewModel,
                                onBackToList = {
                                    devicesViewModel.loadDevices()
                                    navController.popBackStack()
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}
